import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import Stripe from 'stripe';

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });
  return _stripe;
}

// Stripe Price IDs — loaded from environment (functions/.env in dev, Firebase config in prod)
function getPriceId(key: string): string {
  const id = process.env[`STRIPE_PRICE_${key.toUpperCase()}`];
  if (!id) throw new functions.https.HttpsError('internal', `Stripe price ID not configured: STRIPE_PRICE_${key.toUpperCase()}`);
  return id;
}

/**
 * Creates a Stripe Checkout session for plan upgrades.
 * Called from the React Native app via Firebase Functions callable.
 */
export const createCheckoutSession = functions.https.onCall(async (request) => {
  if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, plan, discountCode } = request.data as {
    clinicId: string;
    plan: 'pro' | 'premium' | 'vip';
    discountCode?: string;
  };

  const db = admin.firestore();

  // Verify caller is the clinic owner
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new functions.https.HttpsError('permission-denied', 'Only clinic owners can manage billing');
  }

  // Get or create Stripe customer
  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();
  let customerId: string;

  const existingCustomerId = sub?.stripeCustomerId;
  if (existingCustomerId && existingCustomerId.startsWith('cus_') && !existingCustomerId.includes('REPLACE')) {
    customerId = existingCustomerId;
  } else {
    const clinicDoc = await db.collection('clinics').doc(clinicId).get();
    const clinic = clinicDoc.data();
    const customer = await getStripe().customers.create({
      email: user.email,
      name: clinic?.name,
      metadata: { clinicId },
    });
    customerId = customer.id;
  }

  // ── Discount validation for base-plan checkout ───────────────────────────────
  // usedCount is incremented in the checkout.session.completed webhook, NOT here.
  // Reason: incrementing here would consume the code even if the user abandons checkout.
  // The discountDocId is passed through session metadata so the webhook can find it.
  let stripeCouponId: string | undefined;
  let discountDocId: string | undefined;

  if (discountCode) {
    const discountSnap = await db.collection('discounts')
      .where('code', '==', discountCode)
      .limit(1)
      .get();

    if (discountSnap.empty) {
      throw new functions.https.HttpsError('not-found', `Discount code "${discountCode}" not found`);
    }

    const discountDoc = discountSnap.docs[0];
    const d = discountDoc.data();

    const expired = d.validUntil.toDate() <= new Date();
    const exhausted = d.usedCount >= d.usageLimit;
    if (expired || exhausted) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Discount code "${discountCode}" is ${expired ? 'expired' : 'no longer valid'}`,
      );
    }

    if (!d.appliesToBase) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Discount code "${discountCode}" applies to add-ons only, not to the base plan`,
      );
    }

    const coupon = await getStripe().coupons.create({
      percent_off: d.percentOff,
      duration: 'forever',
      name: discountCode,
    });
    stripeCouponId = coupon.id;
    discountDocId = discountDoc.id;
  }

  const appUrl = process.env.APP_URL ?? 'http://localhost:8081';
  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: getPriceId(plan), quantity: 1 }],
    ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
    metadata: { clinicId, plan, ...(discountDocId ? { discountDocId } : {}) },
    success_url: `${appUrl}/(app)/billing?success=true`,
    cancel_url: `${appUrl}/(app)/billing?canceled=true`,
  });

  return { sessionId: session.id, url: session.url };
});

/**
 * Purchases an add-on for a clinic.
 */
export const purchaseAddon = functions.https.onCall(async (request) => {
  if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, addonType, discountCode } = request.data as {
    clinicId: string;
    addonType: 'extra_storage' | 'extra_seats' | 'advanced_analytics';
    discountCode?: string;
  };

  const db = admin.firestore();

  // Verify caller is the clinic owner
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new functions.https.HttpsError('permission-denied', 'Only clinic owners can purchase add-ons');
  }

  // Check add-on not already active for this clinic
  const existingSnap = await db
    .collection('addons').doc(clinicId).collection('items')
    .where('type', '==', addonType)
    .where('active', '==', true)
    .limit(1)
    .get();
  if (!existingSnap.empty) {
    throw new functions.https.HttpsError('already-exists', `Add-on ${addonType} is already active`);
  }

  // Require a paid subscription
  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();
  if (!sub?.stripeSubscriptionId) {
    throw new functions.https.HttpsError('failed-precondition', 'A paid subscription is required to purchase add-ons');
  }

  const { ADDON_CONFIG_SERVER } = await import('./planConfig');
  const addonConfig = ADDON_CONFIG_SERVER[addonType];

  // ── Discount validation (server-side, non-negotiable) ────────────────────────
  let stripeCouponId: string | undefined;
  let discountDocRef: admin.firestore.DocumentReference | undefined;

  if (discountCode) {
    const discountSnap = await db.collection('discounts')
      .where('code', '==', discountCode)
      .limit(1)
      .get();

    if (discountSnap.empty) {
      throw new functions.https.HttpsError('not-found', `Discount code "${discountCode}" not found`);
    }

    const discountDoc = discountSnap.docs[0];
    const d = discountDoc.data();
    discountDocRef = discountDoc.ref;

    // Reject expired / exhausted codes
    const expired = d.validUntil.toDate() <= new Date();
    const exhausted = d.usedCount >= d.usageLimit;
    if (expired || exhausted) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Discount code "${discountCode}" is ${expired ? 'expired' : 'no longer valid'}`,
      );
    }

    // Reject codes that do not apply to add-ons
    const at = d.appliesToAddons;
    const appliesHere = at === 'all' || (Array.isArray(at) && at.includes(addonType));
    if (!appliesHere) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Discount code "${discountCode}" applies to the base plan only, not to add-ons`,
      );
    }

    // Create a one-off Stripe coupon for this percentage
    const coupon = await getStripe().coupons.create({
      percent_off: d.percentOff,
      duration: 'forever',
      name: discountCode,
    });
    stripeCouponId = coupon.id;
  }

  // ── Add subscription item ────────────────────────────────────────────────────
  let stripeItem: Stripe.SubscriptionItem;
  try {
    stripeItem = await getStripe().subscriptionItems.create({
      subscription: sub.stripeSubscriptionId,
      price: getPriceId(addonType),
      quantity: 1,
      ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
    });
  } catch (err: unknown) {
    const stripeErr = err as { type?: string; param?: string };
    if (stripeErr?.type === 'StripeInvalidRequestError' && stripeErr?.param === 'plan') {
      throw new functions.https.HttpsError('already-exists', `Add-on ${addonType} is already active on this subscription`);
    }
    throw err;
  }

  // ── Write to Firestore atomically ────────────────────────────────────────────
  const addonId = `addon_${addonType}_${Date.now()}`;
  const addonRef = db.collection('addons').doc(clinicId).collection('items').doc(addonId);
  const clinicRef = db.collection('clinics').doc(clinicId);

  await db.runTransaction(async (tx) => {
    tx.set(addonRef, {
      clinicId,
      type: addonType,
      price: addonConfig.price,
      active: true,
      stripeItemId: stripeItem.id,
    });
    tx.update(clinicRef, {
      addons: FieldValue.arrayUnion(addonId),
    });
    if (discountDocRef) {
      tx.update(discountDocRef, {
        usedCount: FieldValue.increment(1),
      });
    }
    // Extra Seats add-on: bump seats.max immediately
    if (addonType === 'extra_seats') {
      const { ADDON_SEATS_BONUS } = await import('./planConfig');
      tx.update(clinicRef, {
        'seats.max': FieldValue.increment(ADDON_SEATS_BONUS),
      });
    }
  });

  return { addonId, price: addonConfig.price };
});

/**
 * Initiates a plan downgrade with seat conflict detection.
 */
export const initiateDowngrade = functions.https.onCall(async (request) => {
  if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetPlan } = request.data as {
    clinicId: string;
    targetPlan: 'free' | 'pro' | 'premium';
  };

  const db = admin.firestore();

  // Verify caller is the clinic owner
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!user || user.role !== 'owner' || user.clinicId !== clinicId) {
    throw new functions.https.HttpsError('permission-denied', 'Only clinic owners can manage billing');
  }

  const { PLAN_CONFIG_SERVER } = await import('./planConfig');
  const targetConfig = PLAN_CONFIG_SERVER[targetPlan];
  const seatLimit = targetConfig.seats === Infinity ? Number.MAX_SAFE_INTEGER : (targetConfig.seats as number);

  // Count active seats (staff only — owner seat is not counted in seats.used)
  const seatsSnap = await db
    .collection('seats')
    .doc(clinicId)
    .collection('members')
    .where('active', '==', true)
    .where('role', '==', 'staff')
    .get();

  const activeStaff = seatsSnap.size;

  if (activeStaff > seatLimit) {
    // Block: owner must deactivate excess staff first (see DECISIONS.md)
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Seat conflict: ${activeStaff} active staff exceed ${targetPlan} plan limit of ${targetConfig.seats}. ` +
        `Deactivate ${activeStaff - (targetConfig.seats as number)} staff member(s) before downgrading.`,
      { conflictingSeats: activeStaff - (targetConfig.seats as number), activeStaff, seatLimit: targetConfig.seats },
    );
  }

  // No conflict — proceed with downgrade
  const subDoc = await db.collection('subscriptions').doc(clinicId).get();
  const sub = subDoc.data();
  if (!sub?.stripeSubscriptionId) {
    throw new functions.https.HttpsError('not-found', 'No active Stripe subscription found');
  }

  if (targetPlan === 'free') {
    // Cancel subscription outright — customer.subscription.deleted webhook handles Firestore
    await getStripe().subscriptions.cancel(sub.stripeSubscriptionId);
  } else {
    // Swap the subscription item to the new price — customer.subscription.updated webhook handles Firestore
    const subscription = await getStripe().subscriptions.retrieve(sub.stripeSubscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) throw new functions.https.HttpsError('internal', 'Subscription has no items');

    await getStripe().subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: itemId, price: getPriceId(targetPlan) }],
      proration_behavior: 'none',
    });
  }

  return { strategy: 'immediate' };
});

/**
 * Removes a staff member and invalidates their session.
 *
 * Approach: combined Option A + B.
 *   - Firestore transaction updates users.role → 'patient' and users.clinicId → null.
 *     Because rules call getUserRole() and belongsToClinic() which read Firestore in
 *     real-time, this blocks ALL Firestore access for the removed user immediately —
 *     no additional rule changes needed.
 *   - revokeRefreshTokens() ensures the user cannot obtain new ID tokens, achieving
 *     complete session invalidation within the 1-hour existing-token window.
 */
export const removeStaffMember = functions.https.onCall(async (request) => {
  if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetUserId } = request.data as { clinicId: string; targetUserId: string };
  const db = admin.firestore();

  await removeStaffMemberFromClinic(db, clinicId, targetUserId, request.auth.uid);

  // Revoke refresh tokens AFTER the Firestore transaction succeeds.
  // If this call fails (e.g. network issue), the user is still blocked by Firestore rules
  // because their role is already updated. Token revocation is best-effort on top.
  try {
    await admin.auth().revokeRefreshTokens(targetUserId);
  } catch (err) {
    console.error('revokeRefreshTokens failed (non-fatal — Firestore rules still block access):', err);
  }
});

/**
 * Core staff removal logic — exported for testing without needing a callable request.
 * Performs all Firestore writes atomically; does NOT revoke tokens (Auth emulator
 * limitations make token revocation unsuitable for integration tests).
 */
export async function removeStaffMemberFromClinic(
  db: admin.firestore.Firestore,
  clinicId: string,
  targetUserId: string,
  callerUserId: string,
): Promise<void> {
  // Verify caller is the clinic owner
  const callerDoc = await db.collection('users').doc(callerUserId).get();
  const caller = callerDoc.data();
  if (!caller || caller.role !== 'owner' || caller.clinicId !== clinicId) {
    throw new functions.https.HttpsError('permission-denied', 'Only clinic owners can remove staff');
  }

  // Verify target is an active staff member of this clinic (not owner, not already removed)
  const targetDoc = await db.collection('users').doc(targetUserId).get();
  const target = targetDoc.data();
  if (!target || target.role !== 'staff' || target.clinicId !== clinicId) {
    throw new functions.https.HttpsError(
      'not-found',
      'Target user is not an active staff member of this clinic',
    );
  }

  const seatRef = db.collection('seats').doc(clinicId).collection('members').doc(targetUserId);
  const userRef = db.collection('users').doc(targetUserId);
  const clinicRef = db.collection('clinics').doc(clinicId);

  await db.runTransaction(async (tx) => {
    // Deactivate the seat record
    tx.update(seatRef, { active: false });

    // Detach the user from the clinic — this is the key step that triggers
    // immediate Firestore rule blocking (getUserRole() → 'patient', belongsToClinic() → false)
    tx.update(userRef, { role: 'patient', clinicId: null });

    // Decrement seat usage counter
    tx.update(clinicRef, { 'seats.used': FieldValue.increment(-1) });
  });
}
