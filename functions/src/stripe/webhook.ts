import * as functions from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import Stripe from 'stripe';

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });
  return _stripe;
}

/**
 * Grace period duration (days).
 * Matches Stripe's Smart Retry window so that by the time our grace period
 * expires, Stripe has already exhausted all payment retries and will send
 * customer.subscription.deleted. Our scheduled expiry acts as a safety net
 * for any timing gaps between Stripe's deletion and our 7-day window.
 */
const GRACE_PERIOD_DAYS = 7;

/**
 * Stripe webhook handler.
 * All billing state in Firestore is written here — never from the client.
 *
 * Events handled:
 *   - checkout.session.completed      → activate subscription
 *   - customer.subscription.updated   → sync plan changes
 *   - invoice.payment_succeeded       → reset grace period, restore status
 *   - invoice.payment_failed          → enter grace period (Scenario 4)
 *   - customer.subscription.deleted   → cancel subscription, revert to Free
 */
export const handleStripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, sig!, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    res.status(400).send('Webhook Error');
    return;
  }

  const db = admin.firestore();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(db, session);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(db, sub);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentSucceeded(db, invoice);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(db, invoice);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(db, sub);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Internal error');
  }
});

/**
 * Scheduled function — runs hourly to expire grace periods.
 *
 * Stripe sends customer.subscription.deleted when it gives up retrying (after
 * ~7 days), which triggers handleSubscriptionDeleted below. This scheduler is
 * a safety net: if that webhook is missed or delayed, we still revert the plan.
 *
 * Production note: the compound query (status + gracePeriodEnd) requires a
 * composite index in Firestore. Deploy with:
 *   firebase deploy --only firestore:indexes
 */
export const expireGracePeriods = onSchedule('every 1 hours', async () => {
  const count = await expireGracePeriodsLogic(admin.firestore());
  if (count > 0) {
    console.log(`expireGracePeriods: reverted ${count} clinic(s) to Free`);
  }
});

// ─── Exported business-logic functions (also used in tests) ──────────────────

/**
 * Handles invoice.payment_failed:
 * sets subscription to grace_period with a 7-day window.
 * Firestore rules will block new staff additions automatically.
 */
export async function handlePaymentFailed(
  db: admin.firestore.Firestore,
  invoice: Stripe.Invoice,
): Promise<void> {
  if (!invoice.customer) return;

  const snap = await db
    .collection('subscriptions')
    .where('stripeCustomerId', '==', invoice.customer)
    .limit(1)
    .get();

  if (snap.empty) {
    console.warn('handlePaymentFailed: no subscription found for customer', invoice.customer);
    return;
  }

  const gracePeriodEnd = Timestamp.fromDate(
    new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000),
  );

  await snap.docs[0].ref.update({
    status: 'grace_period',
    gracePeriodEnd,
  });
}

/**
 * Reverts a clinic to the Free plan in a single atomic transaction:
 * - Subscription: plan=free, status=canceled, clears stripeSubscriptionId + gracePeriodEnd
 * - Clinic: plan=free, seats.max=1, seats.used=0
 * - All active staff seats: active=false
 *
 * Shared by handleSubscriptionDeleted and expireGracePeriodsLogic.
 */
export async function revertToFree(
  db: admin.firestore.Firestore,
  clinicId: string,
  subRef: admin.firestore.DocumentReference,
): Promise<void> {
  const staffSeatsSnap = await db
    .collection('seats')
    .doc(clinicId)
    .collection('members')
    .where('active', '==', true)
    .where('role', '==', 'staff')
    .get();

  const clinicRef = db.collection('clinics').doc(clinicId);

  await db.runTransaction(async (tx) => {
    tx.update(subRef, {
      plan: 'free',
      status: 'canceled',
      stripeSubscriptionId: null,
      gracePeriodEnd: null,
    });

    tx.update(clinicRef, {
      plan: 'free',
      'seats.max': 1,
      'seats.used': 0,
    });

    for (const seatDoc of staffSeatsSnap.docs) {
      tx.update(seatDoc.ref, { active: false });
    }
  });
}

/**
 * Queries all subscriptions past their gracePeriodEnd and reverts each to Free.
 * Returns the number of subscriptions expired.
 * Exported for testing without needing the scheduled function wrapper.
 */
export async function expireGracePeriodsLogic(
  db: admin.firestore.Firestore,
): Promise<number> {
  const snap = await db
    .collection('subscriptions')
    .where('status', '==', 'grace_period')
    .where('gracePeriodEnd', '<=', Timestamp.now())
    .get();

  if (snap.empty) return 0;

  await Promise.all(
    snap.docs.map((doc) => revertToFree(db, doc.id, doc.ref)),
  );

  return snap.size;
}

/**
 * Exported for testing only — thin wrapper so tests can call handleCheckoutCompleted
 * without needing a full Stripe.Checkout.Session object.
 */
export async function handleCheckoutCompletedForTest(
  db: admin.firestore.Firestore,
  session: Stripe.Checkout.Session,
): Promise<void> {
  return handleCheckoutCompleted(db, session);
}

// ─── Private webhook handlers ─────────────────────────────────────────────────

async function handleCheckoutCompleted(
  db: admin.firestore.Firestore,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const clinicId = session.metadata?.clinicId;
  const plan = session.metadata?.plan as 'pro' | 'premium' | 'vip';

  if (!clinicId || !plan) {
    throw new Error('Missing clinicId or plan in session metadata');
  }

  const { PLAN_CONFIG_SERVER } = await import('./planConfig');
  const planConfig = PLAN_CONFIG_SERVER[plan];

  await db.runTransaction(async (tx) => {
    const subRef = db.collection('subscriptions').doc(clinicId);
    const clinicRef = db.collection('clinics').doc(clinicId);

    tx.set(subRef, {
      clinicId,
      plan,
      status: 'active',
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
      currentPeriodEnd: Timestamp.fromDate(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ),
      gracePeriodEnd: null,
    }, { merge: true });

    tx.update(clinicRef, {
      plan,
      'seats.max': planConfig.seats,
    });

    // Increment usedCount for the discount applied at checkout (Scenario 5).
    // Done here — after confirmed payment — not at session creation, so abandoned
    // checkouts do not consume a discount use.
    // Re-validate inside the transaction to close the race window where two concurrent
    // checkouts both pass the usedCount check before either increments.
    const discountDocId = session.metadata?.discountDocId;
    if (discountDocId) {
      const discountRef = db.collection('discounts').doc(discountDocId);
      const discountSnap = await tx.get(discountRef);
      if (discountSnap.exists) {
        const d = discountSnap.data()!;
        if (d.usedCount < d.usageLimit) {
          tx.update(discountRef, { usedCount: FieldValue.increment(1) });
        }
        // If exhausted: discount was already consumed by a concurrent checkout.
        // The coupon is already applied to the Stripe subscription — we don't
        // strip it retroactively (Scenario 5 decision: honor committed deals).
      }
    }
  });
}

async function handleSubscriptionUpdated(
  db: admin.firestore.Firestore,
  stripeSubscription: Stripe.Subscription,
): Promise<void> {
  const snap = await db
    .collection('subscriptions')
    .where('stripeSubscriptionId', '==', stripeSubscription.id)
    .limit(1)
    .get();

  if (snap.empty) {
    console.warn('No clinic found for subscription', stripeSubscription.id);
    return;
  }

  const subDoc = snap.docs[0];
  const clinicId = subDoc.id;

  const priceId = stripeSubscription.items.data[0]?.price.id;
  if (!priceId) {
    console.warn('No price found on subscription', stripeSubscription.id);
    return;
  }

  const priceToplan: Record<string, 'pro' | 'premium' | 'vip'> = {
    [process.env.STRIPE_PRICE_PRO!]: 'pro',
    [process.env.STRIPE_PRICE_PREMIUM!]: 'premium',
    [process.env.STRIPE_PRICE_VIP!]: 'vip',
  };

  const newPlan = priceToplan[priceId];
  if (!newPlan) {
    console.warn('Unrecognized price ID on subscription update:', priceId);
    return;
  }

  const { PLAN_CONFIG_SERVER } = await import('./planConfig');
  const planConfig = PLAN_CONFIG_SERVER[newPlan];
  const clinicRef = db.collection('clinics').doc(clinicId);

  await db.runTransaction(async (tx) => {
    tx.update(subDoc.ref, { plan: newPlan });
    tx.update(clinicRef, {
      plan: newPlan,
      'seats.max': planConfig.seats,
    });
  });
}

async function handleSubscriptionDeleted(
  db: admin.firestore.Firestore,
  stripeSubscription: Stripe.Subscription,
): Promise<void> {
  const snap = await db
    .collection('subscriptions')
    .where('stripeSubscriptionId', '==', stripeSubscription.id)
    .limit(1)
    .get();

  if (snap.empty) {
    console.warn('No clinic found for deleted subscription', stripeSubscription.id);
    return;
  }

  const subDoc = snap.docs[0];
  await revertToFree(db, subDoc.id, subDoc.ref);
}

async function handlePaymentSucceeded(
  db: admin.firestore.Firestore,
  invoice: Stripe.Invoice,
): Promise<void> {
  if (!invoice.customer) return;

  const snap = await db
    .collection('subscriptions')
    .where('stripeCustomerId', '==', invoice.customer)
    .limit(1)
    .get();

  if (snap.empty) return;

  await snap.docs[0].ref.update({
    status: 'active',
    gracePeriodEnd: null,
  });
}
