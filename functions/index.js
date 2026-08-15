const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "europe-west1" });

const STRIPE_SECRET        = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ADMIN_UID            = process.env.ADMIN_UID;

// ── Discount helper ───────────────────────────────────────────────────────────

async function applyDiscount(code, basePrice) {
  if (!code) return { finalPrice: basePrice, discountLabel: null, isFree: false };
  const snap = await db.collection("discountCodes").doc(code.toUpperCase()).get();
  if (!snap.exists) throw new HttpsError("not-found", "Invalid discount code.");
  const dc = snap.data();
  if (!dc.active) throw new HttpsError("failed-precondition", "This discount code is no longer active.");
  if (dc.maxUses !== null && dc.usedCount >= dc.maxUses) {
    throw new HttpsError("resource-exhausted", "This discount code has reached its usage limit.");
  }
  let rawPrice;
  if (dc.type === "percent") {
    rawPrice = basePrice * (1 - dc.value / 100);
  } else {
    rawPrice = Math.max(0, basePrice - dc.value);
  }
  const isFree = rawPrice <= 0;
  const finalPrice = isFree ? 0 : Math.max(0.5, parseFloat(rawPrice.toFixed(2)));
  const label = dc.type === "percent" ? `-${dc.value}%` : `-${dc.value}€`;
  return { finalPrice, discountLabel: label, codeDoc: snap.ref, isFree };
}

// ── Create Stripe Checkout Session ────────────────────────────────────────────

exports.createCheckoutSession = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please log in to purchase.");

  const { tipId, discountCode } = request.data;
  if (!tipId) throw new HttpsError("invalid-argument", "tipId puuttuu.");

  const tipDoc = await db.collection("tips").doc(tipId).get();
  if (!tipDoc.exists) throw new HttpsError("not-found", "Tip not found.");
  const tip = tipDoc.data();
  if (!tip.active) throw new HttpsError("failed-precondition", "This tip is no longer available.");

  const existing = await db.collection("purchases")
    .where("userId", "==", request.auth.uid).where("tipId", "==", tipId).limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists", "You have already purchased this tip.");

  const { finalPrice, discountLabel, codeDoc, isFree } = await applyDiscount(discountCode, tip.price);

  // Free tip (price 0 or 100% discount) → skip Stripe, record free purchase directly
  if (isFree || tip.price === 0) {
    await db.collection("purchases").add({
      tipId,
      userId: request.auth.uid,
      amount: 0,
      currency: "eur",
      discountCode: discountCode ? discountCode.toUpperCase() : null,
      stripeSessionId: null,
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (codeDoc) await codeDoc.update({ usedCount: admin.firestore.FieldValue.increment(1) });
    return { free: true };
  }

  const stripe = require("stripe")(STRIPE_SECRET);
  const productName = discountLabel
    ? `${tip.title} (${discountLabel})`
    : tip.title;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "eur",
        product_data: { name: productName, description: `${tip.sport} — ${tip.match}` },
        unit_amount: Math.round(finalPrice * 100),
      },
      quantity: 1,
    }],
    mode: "payment",
    success_url: "https://vkzzbetting.com/?success=1",
    cancel_url:  "https://vkzzbetting.com/",
    metadata: {
      tipId,
      userId: request.auth.uid,
      discountCode: discountCode ? discountCode.toUpperCase() : "",
    },
  });

  if (codeDoc) {
    await codeDoc.update({ usedCount: admin.firestore.FieldValue.increment(1) });
  }

  return { url: session.url };
});

// ── Stripe Webhook ────────────────────────────────────────────────────────────

exports.stripeWebhook = onRequest({ rawBody: true }, async (req, res) => {
  const stripe = require("stripe")(STRIPE_SECRET);
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.metadata.type === "topup") {
      const { userId, amount } = session.metadata;
      const paid = parseFloat(amount);
      const bonusSnap = await db.collection("settings").doc("topup").get();
      const bonusCfg = bonusSnap.exists ? bonusSnap.data() : { active: false, bonusPercent: 0 };
      const credited = bonusCfg.active ? paid * (1 + bonusCfg.bonusPercent / 100) : paid;
      const creditedRounded = parseFloat(credited.toFixed(2));
      await Promise.all([
        db.collection("users").doc(userId).update({
          balance: admin.firestore.FieldValue.increment(creditedRounded),
        }),
        db.collection("topups").add({
          userId,
          paid,
          credited: creditedRounded,
          bonusPercent: bonusCfg.active ? bonusCfg.bonusPercent : 0,
          stripeSessionId: session.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      ]);
    } else if (session.metadata.type === "split_purchase") {
      const { tipId, userId, balanceUsed, discountCode } = session.metadata;
      const balUsed = parseFloat(balanceUsed);
      await db.runTransaction(async t => {
        const userRef = db.collection("users").doc(userId);
        const uDoc = await t.get(userRef);
        const currentBal = uDoc.data()?.balance || 0;
        const actualDeduction = Math.min(currentBal, balUsed);
        if (actualDeduction > 0)
          t.update(userRef, { balance: admin.firestore.FieldValue.increment(-actualDeduction) });
        t.set(db.collection("purchases").doc(), {
          tipId, userId,
          amount: parseFloat((session.amount_total / 100 + actualDeduction).toFixed(2)),
          balanceUsed: actualDeduction,
          currency: session.currency,
          discountCode: discountCode || null,
          stripeSessionId: session.id,
          paidWithBalance: actualDeduction > 0,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    } else {
      const { tipId, userId, discountCode } = session.metadata;
      await db.collection("purchases").add({
        tipId,
        userId,
        amount: session.amount_total / 100,
        currency: session.currency,
        discountCode: discountCode || null,
        stripeSessionId: session.id,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  res.json({ received: true });
});

// ── Add Tip (admin only) ──────────────────────────────────────────────────────

exports.addTip = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { title, sport, match, date, odds, stake, price, category, content } = request.data;
  if (!title || price == null || isNaN(price) || !content)
    throw new HttpsError("invalid-argument", "Fill in required fields.");

  const ref = await db.collection("tips").add({
    title, sport: sport || "", match: match || "", date: date || "",
    odds: odds || null, stake: stake || null,
    price: parseFloat(price), category: category || "premium", content,
    active: true, result: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { id: ref.id };
});

// ── Add Discount Code (admin only) ────────────────────────────────────────────

exports.addDiscountCode = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { code, type, value, maxUses } = request.data;
  if (!code || !type || value == null)
    throw new HttpsError("invalid-argument", "Pakollisia kenttiä puuttuu.");
  if (!["percent", "fixed"].includes(type))
    throw new HttpsError("invalid-argument", "type täytyy olla percent tai fixed.");
  if (type === "percent" && (value <= 0 || value > 100))
    throw new HttpsError("invalid-argument", "Prosentti täytyy olla 1–100.");

  const key = code.toUpperCase().trim();
  await db.collection("discountCodes").doc(key).set({
    code: key,
    type,
    value: parseFloat(value),
    maxUses: maxUses ? parseInt(maxUses) : null,
    usedCount: 0,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { code: key };
});

// ── List Discount Codes (admin only) ─────────────────────────────────────────

exports.listDiscountCodes = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const snap = await db.collection("discountCodes").orderBy("createdAt", "desc").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis() }));
});

// ── Toggle Discount Code active (admin only) ──────────────────────────────────

exports.toggleDiscountCode = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { code, active } = request.data;
  await db.collection("discountCodes").doc(code).update({ active });
  return { ok: true };
});

// ── List Users (admin only) ───────────────────────────────────────────────────

exports.listUsers = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const snap = await db.collection("users").orderBy("createdAt", "desc").get();
  return snap.docs.map(d => {
    const u = d.data();
    return {
      uid:         d.id,
      displayName: u.displayName || "",
      email:       u.email || "",
      phone:       u.phone || "",
      newsletter:  u.newsletter || false,
      balance:     typeof u.balance === "number" ? u.balance : 0,
      createdAt:   u.createdAt?._seconds ? u.createdAt._seconds * 1000 : (u.createdAt?.toMillis ? u.createdAt.toMillis() : null),
    };
  });
});

// ── List Purchases (admin only) ───────────────────────────────────────────────

exports.listPurchases = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const [purchasesSnap, tipsSnap, usersSnap] = await Promise.all([
    db.collection("purchases").orderBy("purchasedAt", "desc").get(),
    db.collection("tips").get(),
    db.collection("users").get(),
  ]);

  const tips  = {};
  tipsSnap.forEach(d => tips[d.id] = d.data());
  const users = {};
  usersSnap.forEach(d => users[d.id] = d.data());

  const toMs = ts => ts?._seconds ? ts._seconds * 1000 : (ts?.toMillis ? ts.toMillis() : null);

  return purchasesSnap.docs.map(d => {
    const p    = d.data();
    const tip  = tips[p.tipId]   || {};
    const user = users[p.userId] || {};
    return {
      id:           d.id,
      tipId:        p.tipId,
      tipTitle:     tip.title  || "—",
      tipSport:     tip.sport  || "",
      userId:       p.userId,
      userName:     user.displayName || "",
      userEmail:    user.email       || p.userId,
      amount:          p.amount  ?? 0,
      balanceUsed:     p.balanceUsed ?? 0,
      discountCode:    p.discountCode || null,
      paidWithBalance: p.paidWithBalance || false,
      purchasedAt:     toMs(p.purchasedAt),
    };
  });
});

// ── Delete Tip (admin only) ───────────────────────────────────────────────────

exports.deleteTip = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { tipId } = request.data;
  if (!tipId) throw new HttpsError("invalid-argument", "tipId puuttuu.");

  await db.collection("tips").doc(tipId).update({
    active: false,
    archived: true,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// ── Restore Tip (admin only) ──────────────────────────────────────────────────

exports.restoreTip = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { tipId } = request.data;
  await db.collection("tips").doc(tipId).update({ active: true, archived: false });
  return { ok: true };
});

// ── Create Top-Up Session ─────────────────────────────────────────────────────

exports.createTopUpSession = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please log in.");
  const { amount } = request.data;
  const parsed = parseFloat(amount);
  if (!parsed || isNaN(parsed) || parsed < 1 || parsed > 500)
    throw new HttpsError("invalid-argument", "Amount must be between 1 and 500.");

  const bonusSnap = await db.collection("settings").doc("topup").get();
  const bonusCfg = bonusSnap.exists ? bonusSnap.data() : { active: false, bonusPercent: 0 };
  const credited = bonusCfg.active ? parsed * (1 + bonusCfg.bonusPercent / 100) : parsed;

  const stripe = require("stripe")(STRIPE_SECRET);
  const productName = bonusCfg.active
    ? `Balance top-up: ${parsed}€ → ${credited.toFixed(2)}€ credited (+${bonusCfg.bonusPercent}% bonus)`
    : `Balance top-up: ${parsed}€`;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "eur",
        product_data: { name: productName },
        unit_amount: Math.round(parsed * 100),
      },
      quantity: 1,
    }],
    mode: "payment",
    success_url: "https://vkzzbetting.com/?topup=1",
    cancel_url:  "https://vkzzbetting.com/",
    metadata: { type: "topup", userId: request.auth.uid, amount: String(parsed) },
  });

  return { url: session.url };
});

// ── Buy Tip With Balance ──────────────────────────────────────────────────────

exports.buyTipWithBalance = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please log in.");
  const { tipId, discountCode } = request.data;
  if (!tipId) throw new HttpsError("invalid-argument", "tipId missing.");

  const tipDoc = await db.collection("tips").doc(tipId).get();
  if (!tipDoc.exists) throw new HttpsError("not-found", "Tip not found.");
  const tip = tipDoc.data();
  if (!tip.active) throw new HttpsError("failed-precondition", "This tip is no longer available.");

  const existing = await db.collection("purchases")
    .where("userId", "==", request.auth.uid).where("tipId", "==", tipId).limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists", "You already purchased this tip.");

  const { finalPrice, codeDoc } = await applyDiscount(discountCode, tip.price);

  await db.runTransaction(async (t) => {
    const userRef = db.collection("users").doc(request.auth.uid);
    const userDoc = await t.get(userRef);
    const balance = userDoc.data()?.balance || 0;
    if (balance < finalPrice)
      throw new HttpsError("failed-precondition", `Insufficient balance. You have ${balance.toFixed(2)}€.`);
    t.update(userRef, { balance: admin.firestore.FieldValue.increment(-parseFloat(finalPrice.toFixed(2))) });
    t.set(db.collection("purchases").doc(), {
      tipId,
      userId: request.auth.uid,
      amount: finalPrice,
      currency: "eur",
      discountCode: discountCode ? discountCode.toUpperCase() : null,
      stripeSessionId: null,
      paidWithBalance: true,
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  if (codeDoc) await codeDoc.update({ usedCount: admin.firestore.FieldValue.increment(1) });
  return { ok: true };
});

// ── Admin: Add Balance to User ────────────────────────────────────────────────

exports.adminAddBalance = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "No permission.");
  const { userId, amount } = request.data;
  if (!userId || amount == null || isNaN(amount))
    throw new HttpsError("invalid-argument", "userId and amount required.");
  const delta = parseFloat(parseFloat(amount).toFixed(2));
  // Use set+merge so it works even if the user doc doesn't exist yet (e.g. admin account)
  await db.collection("users").doc(userId).set(
    { balance: admin.firestore.FieldValue.increment(delta) },
    { merge: true }
  );
  return { ok: true };
});

// ── Admin: Get/Set Top-Up Bonus ───────────────────────────────────────────────

exports.getTopUpBonus = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "No permission.");
  const snap = await db.collection("settings").doc("topup").get();
  return snap.exists ? snap.data() : { active: false, bonusPercent: 0 };
});

exports.setTopUpBonus = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "No permission.");
  const { active, bonusPercent } = request.data;
  if (bonusPercent == null || isNaN(bonusPercent) || bonusPercent < 0 || bonusPercent > 1000)
    throw new HttpsError("invalid-argument", "bonusPercent must be 0–1000.");
  await db.collection("settings").doc("topup").set({ active: !!active, bonusPercent: parseFloat(bonusPercent) });
  return { ok: true };
});

// ── Create Split Payment Session (balance + card) ─────────────────────────────

exports.createSplitPaymentSession = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please log in.");
  const { tipId, discountCode } = request.data;

  const tipDoc = await db.collection("tips").doc(tipId).get();
  if (!tipDoc.exists || !tipDoc.data().active)
    throw new HttpsError("not-found", "Tip not found.");
  const tip = tipDoc.data();

  const existing = await db.collection("purchases")
    .where("userId", "==", request.auth.uid).where("tipId", "==", tipId).limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists", "You already purchased this tip.");

  const { finalPrice, codeDoc, isFree } = await applyDiscount(discountCode, tip.price);

  if (isFree || finalPrice <= 0) {
    await db.collection("purchases").add({
      tipId, userId: request.auth.uid, amount: 0, currency: "eur",
      discountCode: discountCode ? discountCode.toUpperCase() : null,
      stripeSessionId: null, purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (codeDoc) await codeDoc.update({ usedCount: admin.firestore.FieldValue.increment(1) });
    return { free: true };
  }

  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  const balance = userDoc.data()?.balance || 0;
  const balanceUsed = parseFloat(Math.min(balance, finalPrice).toFixed(2));
  const stripeAmount = parseFloat((finalPrice - balanceUsed).toFixed(2));

  if (stripeAmount < 0.5) {
    // Remainder below Stripe minimum — pay entirely with balance
    await db.runTransaction(async t => {
      const userRef = db.collection("users").doc(request.auth.uid);
      const uDoc = await t.get(userRef);
      const bal = uDoc.data()?.balance || 0;
      if (bal < finalPrice) throw new HttpsError("failed-precondition", "Insufficient balance.");
      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-finalPrice) });
      t.set(db.collection("purchases").doc(), {
        tipId, userId: request.auth.uid, amount: finalPrice, currency: "eur",
        discountCode: discountCode ? discountCode.toUpperCase() : null,
        stripeSessionId: null, paidWithBalance: true,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    if (codeDoc) await codeDoc.update({ usedCount: admin.firestore.FieldValue.increment(1) });
    return { free: true };
  }

  const stripe = require("stripe")(STRIPE_SECRET);
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "eur",
        product_data: { name: `${tip.title} (${balanceUsed.toFixed(2)}€ from balance + ${stripeAmount.toFixed(2)}€ card)` },
        unit_amount: Math.round(stripeAmount * 100),
      },
      quantity: 1,
    }],
    mode: "payment",
    success_url: "https://vkzzbetting.com/?success=1",
    cancel_url:  "https://vkzzbetting.com/",
    metadata: {
      type: "split_purchase",
      tipId, userId: request.auth.uid,
      balanceUsed: String(balanceUsed),
      discountCode: discountCode ? discountCode.toUpperCase() : "",
    },
  });

  if (codeDoc) await codeDoc.update({ usedCount: admin.firestore.FieldValue.increment(1) });
  return { url: session.url };
});

// ── List Top-Ups (admin only) ─────────────────────────────────────────────────

exports.listTopUps = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "No permission.");

  const [topupsSnap, usersSnap] = await Promise.all([
    db.collection("topups").orderBy("createdAt", "desc").get(),
    db.collection("users").get(),
  ]);

  const users = {};
  usersSnap.forEach(d => users[d.id] = d.data());
  const toMs = ts => ts?._seconds ? ts._seconds * 1000 : (ts?.toMillis ? ts.toMillis() : null);

  return topupsSnap.docs.map(d => {
    const t = d.data();
    const u = users[t.userId] || {};
    return {
      id: d.id,
      userId: t.userId,
      userName: u.displayName || "",
      userEmail: u.email || t.userId,
      paid: t.paid,
      credited: t.credited,
      bonusPercent: t.bonusPercent || 0,
      stripeSessionId: t.stripeSessionId,
      createdAt: toMs(t.createdAt),
    };
  });
});
