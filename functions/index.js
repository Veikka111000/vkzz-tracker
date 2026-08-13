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
    success_url: "https://vkzz00.github.io/vkzz-tracker/?success=1",
    cancel_url:  "https://vkzz00.github.io/vkzz-tracker/",
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

  res.json({ received: true });
});

// ── Add Tip (admin only) ──────────────────────────────────────────────────────

exports.addTip = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { title, sport, match, date, odds, stake, price, content } = request.data;
  if (!title || price == null || isNaN(price) || !content)
    throw new HttpsError("invalid-argument", "Fill in required fields.");

  const ref = await db.collection("tips").add({
    title, sport: sport || "", match: match || "", date: date || "",
    odds: odds || null, stake: stake || null,
    price: parseFloat(price), content,
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
      amount:       p.amount  ?? 0,
      discountCode: p.discountCode || null,
      purchasedAt:  toMs(p.purchasedAt),
    };
  });
});

// ── Delete Tip (admin only) ───────────────────────────────────────────────────

exports.deleteTip = onCall({ cors: true }, async (request) => {
  if (!request.auth || request.auth.uid !== ADMIN_UID)
    throw new HttpsError("permission-denied", "Ei oikeuksia.");

  const { tipId } = request.data;
  if (!tipId) throw new HttpsError("invalid-argument", "tipId puuttuu.");

  await db.collection("tips").doc(tipId).delete();
  return { ok: true };
});
