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
        // TODO [CHALLENGE]: Handle subscription cancellation.
        // Revert plan to 'free', status to 'canceled'.
        // Deactivate seats exceeding free plan limit (1 seat).
        // Owner keeps their seat; excess staff are deactivated.
        const sub = event.data.object as Stripe.Subscription;
        console.log('TODO [CHALLENGE]: Handle subscription deleted for', sub.id);
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
  // Find clinic by stripeSubscriptionId
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

  // Stripe stores the current plan in the subscription items
  // TODO [CHALLENGE]: Parse the plan from stripeSubscription.items to determine the new plan
  // and update Firestore accordingly. This is called on upgrades and downgrades.
  console.log('TODO [CHALLENGE]: Sync subscription update for clinic', clinicId);
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
