/**
 * Integration tests for Scenario 4 (payment failure / grace period)
 * and Scenario 5 (expired discount — usedCount only incremented on confirmed payment).
 *
 * Requires the Firestore emulator running on localhost:8080.
 * Start it with: firebase emulators:start --only firestore
 * Then run: npm test
 */

import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { handlePaymentFailed, revertToFree, expireGracePeriodsLogic, handleCheckoutCompletedForTest } from './webhook';
import type Stripe from 'stripe';

// ─── Emulator setup ──────────────────────────────────────────────────────────

let db: admin.firestore.Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: 'clinic-test-local' });
  }
  db = admin.firestore();
});

/** Clears ALL Firestore data in the emulator between tests to ensure isolation. */
async function clearEmulatorData(): Promise<void> {
  const url =
    'http://localhost:8080/emulator/v1/projects/clinic-test-local/databases/(default)/documents';
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator data: ${res.status} ${await res.text()}`);
  }
}

beforeEach(async () => {
  await clearEmulatorData();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInvoice(customer: string): Stripe.Invoice {
  return { id: 'in_test', customer } as unknown as Stripe.Invoice;
}

async function seedSubscription(
  clinicId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await db.collection('subscriptions').doc(clinicId).set({
    clinicId,
    plan: 'pro',
    status: 'active',
    stripeCustomerId: `cus_${clinicId}`,
    stripeSubscriptionId: `sub_${clinicId}`,
    gracePeriodEnd: null,
    currentPeriodEnd: Timestamp.fromDate(new Date(Date.now() + 30 * 86_400_000)),
    ...overrides,
  });
}

async function seedClinic(clinicId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await db.collection('clinics').doc(clinicId).set({
    name: `Test Clinic ${clinicId}`,
    plan: 'pro',
    seats: { used: 2, max: 5 },
    ...overrides,
  });
}

async function seedStaffSeat(clinicId: string, userId: string): Promise<void> {
  await db
    .collection('seats')
    .doc(clinicId)
    .collection('members')
    .doc(userId)
    .set({ role: 'staff', active: true });
}

// ─── handlePaymentFailed ─────────────────────────────────────────────────────

describe('handlePaymentFailed', () => {
  it('sets status=grace_period and writes gracePeriodEnd ~7 days out', async () => {
    const clinicId = 'clinic_pf_1';
    await seedSubscription(clinicId);

    const before = Date.now();
    await handlePaymentFailed(db, makeInvoice(`cus_${clinicId}`));
    const after = Date.now();

    const snap = await db.collection('subscriptions').doc(clinicId).get();
    const data = snap.data()!;

    expect(data.status).toBe('grace_period');
    expect(data.gracePeriodEnd).not.toBeNull();

    const gpMs = data.gracePeriodEnd.toDate().getTime();
    const expectedMin = before  + 7 * 86_400_000;
    const expectedMax = after   + 7 * 86_400_000;
    expect(gpMs).toBeGreaterThanOrEqual(expectedMin);
    expect(gpMs).toBeLessThanOrEqual(expectedMax);
  });

  it('does not touch other fields (plan, stripeSubscriptionId)', async () => {
    const clinicId = 'clinic_pf_2';
    await seedSubscription(clinicId);

    await handlePaymentFailed(db, makeInvoice(`cus_${clinicId}`));

    const data = (await db.collection('subscriptions').doc(clinicId).get()).data()!;
    expect(data.plan).toBe('pro');
    expect(data.stripeSubscriptionId).toBe(`sub_${clinicId}`);
  });

  it('does nothing (no throw) when no subscription matches the customer', async () => {
    await expect(
      handlePaymentFailed(db, makeInvoice('cus_does_not_exist')),
    ).resolves.toBeUndefined();
  });

  it('does nothing when invoice has no customer field', async () => {
    await expect(
      handlePaymentFailed(db, {} as Stripe.Invoice),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — calling twice does not throw and keeps grace_period', async () => {
    const clinicId = 'clinic_pf_idempotent';
    await seedSubscription(clinicId);

    await handlePaymentFailed(db, makeInvoice(`cus_${clinicId}`));
    const first = (await db.collection('subscriptions').doc(clinicId).get()).data()!;

    // Second call (e.g. Stripe retry)
    await handlePaymentFailed(db, makeInvoice(`cus_${clinicId}`));
    const second = (await db.collection('subscriptions').doc(clinicId).get()).data()!;

    expect(second.status).toBe('grace_period');
    // gracePeriodEnd should be refreshed (second call is later, so it extends the window)
    expect(second.gracePeriodEnd.toDate().getTime()).toBeGreaterThanOrEqual(
      first.gracePeriodEnd.toDate().getTime(),
    );
  });
});

// ─── revertToFree ────────────────────────────────────────────────────────────

describe('revertToFree', () => {
  it('sets plan=free, status=canceled, clears stripeSubscriptionId and gracePeriodEnd', async () => {
    const clinicId = 'clinic_rf_1';
    await seedSubscription(clinicId, {
      status: 'grace_period',
      gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() - 1000)),
    });
    await seedClinic(clinicId);

    const subRef = db.collection('subscriptions').doc(clinicId);
    await revertToFree(db, clinicId, subRef);

    const data = (await subRef.get()).data()!;
    expect(data.plan).toBe('free');
    expect(data.status).toBe('canceled');
    expect(data.stripeSubscriptionId).toBeNull();
    expect(data.gracePeriodEnd).toBeNull();
  });

  it('resets clinic seats.max to 1 and seats.used to 0', async () => {
    const clinicId = 'clinic_rf_2';
    await seedSubscription(clinicId, { status: 'grace_period', gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() - 1000)) });
    await seedClinic(clinicId, { seats: { used: 3, max: 5 } });

    const subRef = db.collection('subscriptions').doc(clinicId);
    await revertToFree(db, clinicId, subRef);

    const clinic = (await db.collection('clinics').doc(clinicId).get()).data()!;
    expect(clinic.seats.max).toBe(1);
    expect(clinic.seats.used).toBe(0);
  });

  it('deactivates all active staff seats', async () => {
    const clinicId = 'clinic_rf_3';
    await seedSubscription(clinicId, { status: 'grace_period', gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() - 1000)) });
    await seedClinic(clinicId);
    await seedStaffSeat(clinicId, 'staff_a');
    await seedStaffSeat(clinicId, 'staff_b');

    const subRef = db.collection('subscriptions').doc(clinicId);
    await revertToFree(db, clinicId, subRef);

    const seats = await db.collection('seats').doc(clinicId).collection('members').get();
    expect(seats.docs.every((d) => d.data().active === false)).toBe(true);
  });

  it('succeeds with no staff seats (owner-only clinic)', async () => {
    const clinicId = 'clinic_rf_4';
    await seedSubscription(clinicId, { status: 'grace_period', gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() - 1000)) });
    await seedClinic(clinicId, { seats: { used: 0, max: 5 } });

    const subRef = db.collection('subscriptions').doc(clinicId);
    await expect(revertToFree(db, clinicId, subRef)).resolves.toBeUndefined();
  });
});

// ─── expireGracePeriodsLogic ─────────────────────────────────────────────────

describe('expireGracePeriodsLogic', () => {
  it('expires a grace period that has passed and returns count=1', async () => {
    const clinicId = 'clinic_eg_1';
    await seedSubscription(clinicId, {
      status: 'grace_period',
      gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() - 1000)), // 1 second ago
    });
    await seedClinic(clinicId);

    const count = await expireGracePeriodsLogic(db);

    expect(count).toBe(1);
    const data = (await db.collection('subscriptions').doc(clinicId).get()).data()!;
    expect(data.status).toBe('canceled');
  });

  it('does NOT expire a grace period that has not ended yet', async () => {
    const clinicId = 'clinic_eg_2';
    await seedSubscription(clinicId, {
      status: 'grace_period',
      gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() + 86_400_000)), // 1 day ahead
    });
    await seedClinic(clinicId);

    const count = await expireGracePeriodsLogic(db);

    expect(count).toBe(0);
    const data = (await db.collection('subscriptions').doc(clinicId).get()).data()!;
    expect(data.status).toBe('grace_period'); // unchanged
  });

  it('does not touch active subscriptions', async () => {
    const clinicId = 'clinic_eg_3';
    await seedSubscription(clinicId); // status: active

    const count = await expireGracePeriodsLogic(db);

    expect(count).toBe(0);
    const data = (await db.collection('subscriptions').doc(clinicId).get()).data()!;
    expect(data.status).toBe('active');
  });

  it('returns 0 and does not throw when there are no grace-period subscriptions', async () => {
    const count = await expireGracePeriodsLogic(db);
    expect(count).toBe(0);
  });

  it('expires multiple expired grace periods in one pass', async () => {
    const expired = Timestamp.fromDate(new Date(Date.now() - 1000));
    for (const id of ['clinic_eg_multi_1', 'clinic_eg_multi_2']) {
      await seedSubscription(id, { status: 'grace_period', gracePeriodEnd: expired });
      await seedClinic(id);
    }
    // One still active — should NOT be expired
    await seedSubscription('clinic_eg_multi_3', {
      status: 'grace_period',
      gracePeriodEnd: Timestamp.fromDate(new Date(Date.now() + 86_400_000)),
    });
    await seedClinic('clinic_eg_multi_3');

    const count = await expireGracePeriodsLogic(db);

    expect(count).toBe(2);
    for (const id of ['clinic_eg_multi_1', 'clinic_eg_multi_2']) {
      const d = (await db.collection('subscriptions').doc(id).get()).data()!;
      expect(d.status).toBe('canceled');
    }
    const d3 = (await db.collection('subscriptions').doc('clinic_eg_multi_3').get()).data()!;
    expect(d3.status).toBe('grace_period');
  });
});

// ─── Scenario 5 — discount usedCount incremented on confirmed payment ─────────

describe('handleCheckoutCompleted — discount usedCount', () => {
  function makeSession(
    clinicId: string,
    customerId: string,
    discountDocId?: string,
  ): Stripe.Checkout.Session {
    return {
      customer: customerId,
      subscription: `sub_${clinicId}`,
      metadata: {
        clinicId,
        plan: 'pro',
        ...(discountDocId ? { discountDocId } : {}),
      },
    } as unknown as Stripe.Checkout.Session;
  }

  it('increments discount usedCount on confirmed checkout', async () => {
    const clinicId = 'clinic_s5_1';
    const discountId = 'discount_s5_1';

    await seedClinic(clinicId, { plan: 'free', seats: { used: 0, max: 1 } });
    await db.collection('discounts').doc(discountId).set({
      code: 'TEST20',
      percentOff: 20,
      appliesToBase: true,
      appliesToAddons: [],
      validUntil: Timestamp.fromDate(new Date(Date.now() + 86_400_000)),
      usageLimit: 10,
      usedCount: 2,
    });

    await handleCheckoutCompletedForTest(db, makeSession(clinicId, `cus_${clinicId}`, discountId));

    const discountSnap = await db.collection('discounts').doc(discountId).get();
    expect(discountSnap.data()!.usedCount).toBe(3); // incremented from 2 → 3
  });

  it('does NOT increment usedCount when no discount was applied', async () => {
    const clinicId = 'clinic_s5_2';
    const discountId = 'discount_s5_2';

    await seedClinic(clinicId, { plan: 'free', seats: { used: 0, max: 1 } });
    await db.collection('discounts').doc(discountId).set({
      code: 'NODISCOUNT',
      percentOff: 10,
      appliesToBase: true,
      appliesToAddons: [],
      validUntil: Timestamp.fromDate(new Date(Date.now() + 86_400_000)),
      usageLimit: 10,
      usedCount: 5,
    });

    // No discountDocId in session metadata
    await handleCheckoutCompletedForTest(db, makeSession(clinicId, `cus_${clinicId}`));

    const discountSnap = await db.collection('discounts').doc(discountId).get();
    expect(discountSnap.data()!.usedCount).toBe(5); // unchanged
  });
});
