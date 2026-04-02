import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
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

  // TODO [CHALLENGE]: Validate and apply discount code (Scenario 3 & 5).
  // Before creating the session:
  //   1. Look up the discount in Firestore by code
  //   2. Check isDiscountValid() — reject expired codes (Scenario 5)
  //   3. Check appliesToBase — if false, do not apply to the base plan checkout
  //   4. If valid and applicable, create or retrieve a Stripe Coupon and attach to session
  //   5. Increment discount.usedCount atomically (Firestore transaction)
  let stripeCouponId: string | undefined;
  if (discountCode) {
    console.log('TODO [CHALLENGE]: Validate and apply discount code:', discountCode);
  }

  const appUrl = process.env.APP_URL ?? 'http://localhost:8081';
  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: getPriceId(plan), quantity: 1 }],
    ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
    metadata: { clinicId, plan },
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

  // TODO [CHALLENGE]: Implement add-on purchase (Scenario 3).
  // Steps:
  //   1. Verify caller is owner of clinicId
  //   2. Look up the clinic's active Stripe subscription
  //   3. Add a new subscription item for the add-on price
  //   4. If discountCode provided:
  //      a. Fetch discount from Firestore
  //      b. Check appliesToAddons — does it include this addonType or 'all'?
  //      c. IMPORTANT: A discount that applies to base plan only must NOT apply here
  //      d. Apply applicable discount to the subscription item
  //   5. On success, write addon record to addons/{clinicId}/items/{addonId}
  //   6. Update clinic.addons array
  console.log('TODO [CHALLENGE]: Implement purchaseAddon for', addonType, 'clinic', clinicId, discountCode);
  throw new functions.https.HttpsError('unimplemented', 'TODO [CHALLENGE]: Implement purchaseAddon');
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
 * Must be atomic: seat decrement + role update + session revocation in one operation.
 */
export const removeStaffMember = functions.https.onCall(async (request) => {
  if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');

  const { clinicId, targetUserId } = request.data as { clinicId: string; targetUserId: string };

  // TODO [CHALLENGE]: Implement staff removal + session invalidation (Scenario 6).
  // Steps:
  //   1. Verify caller is owner of clinicId
  //   2. Verify targetUserId is a staff member (not owner) of clinicId
  //   3. In a Firestore transaction:
  //      a. Set seats/{clinicId}/members/{targetUserId}.active = false
  //      b. Update users/{targetUserId}: clear clinicId, set role to 'patient'
  //      c. Decrement clinic.seats.used
  //   4. Revoke Firebase Auth refresh tokens for targetUserId:
  //      admin.auth().revokeRefreshTokens(targetUserId)
  //      This invalidates ALL active sessions for that user immediately.
  //   5. Optionally notify the removed user
  //
  // Note on token revocation: Firebase tokens are valid for 1 hour after revocation.
  // To enforce immediate blocking, Firestore rules must check the user's active status,
  // not just their role. The rules in seats/ are intentionally incomplete — add this check.
  console.log('TODO [CHALLENGE]: Implement removeStaffMember for', targetUserId, 'in clinic', clinicId);
  throw new functions.https.HttpsError('unimplemented', 'TODO [CHALLENGE]: Implement removeStaffMember');
});
