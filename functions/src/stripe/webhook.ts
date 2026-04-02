import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import Stripe from 'stripe';

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });
  return _stripe;
}

const GRACE_PERIOD_DAYS = 7; // Document: chosen to match Stripe's own retry window

/**
 * Stripe webhook handler.
 * All billing state in Firestore is written here — never from the client.
 *
 * Events handled:
 *   - checkout.session.completed  → activate subscription
 *   - customer.subscription.updated → sync plan changes
 *   - invoice.payment_succeeded   → reset grace period, restore status
 *   - invoice.payment_failed      → enter grace period (Scenario 4)
 *   - customer.subscription.deleted → cancel subscription, revert to Free
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
        // TODO [CHALLENGE]: Implement Scenario 4 — payment failure → grace period.
        // Steps:
        //   1. Look up the clinic by stripeCustomerId
        //   2. Set subscription.status = 'grace_period'
        //   3. Set subscription.gracePeriodEnd = now + GRACE_PERIOD_DAYS
        //   4. Write to Firestore — Firestore rules will enforce restrictions automatically
        //   5. Optionally: send a notification (email/push) to the owner
        //
        // Decision point: GRACE_PERIOD_DAYS is set to 7 above.
        // Rationale: matches Stripe's Smart Retries window, so by the time grace ends,
        // Stripe has already given up retrying.
        const invoice = event.data.object as Stripe.Invoice;
        console.log('TODO [CHALLENGE]: Handle payment failure for invoice', invoice.id);
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
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // ~1 month
      ),
      gracePeriodEnd: null,
    }, { merge: true });

    // Update clinic's plan mirror and seat max
    tx.update(clinicRef, {
      plan,
      'seats.max': planConfig.seats,
    });
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

  // Map the active price ID back to a plan name using environment variables
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
  const clinicId = subDoc.id;

  // Query all active staff seats (owner keeps their seat)
  const staffSeatsSnap = await db
    .collection('seats')
    .doc(clinicId)
    .collection('members')
    .where('active', '==', true)
    .where('role', '==', 'staff')
    .get();

  const clinicRef = db.collection('clinics').doc(clinicId);

  await db.runTransaction(async (tx) => {
    // Revert subscription to free / canceled
    tx.update(subDoc.ref, {
      plan: 'free',
      status: 'canceled',
      stripeSubscriptionId: null,
      gracePeriodEnd: null,
    });

    // Mirror on clinic
    tx.update(clinicRef, {
      plan: 'free',
      'seats.max': 1,
      'seats.used': 0,
    });

    // Deactivate all staff seats — owner keeps theirs
    for (const seatDoc of staffSeatsSnap.docs) {
      tx.update(seatDoc.ref, { active: false });
    }
  });
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
