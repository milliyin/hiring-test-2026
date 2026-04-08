/**
 * Seed script — populates the Firebase Emulator with realistic test data.
 * Run with: npm run seed
 *
 * Creates:
 *   - 1 clinic (Alpine Aesthetics Clinic)
 *   - 1 owner (sophie.owner@test.com / password: test1234)
 *   - 2 staff (anna.staff@test.com, marc.staff@test.com / password: test1234)
 *   - 2 patients (patient1@test.com, patient2@test.com / password: test1234)
 *   - 1 active Pro subscription
 *   - 1 active add-on (extra_storage)
 *   - 1 active discount (20% off base plan only)
 *   - 1 expired discount (15% off all add-ons — for Scenario 5)
 *   - 4 appointments (mix of statuses)
 *
 * Architecture note:
 *   Auth operations use the Firebase client SDK (the only way to create Auth users
 *   with passwords via the emulator). All Firestore writes use the Admin SDK, which
 *   bypasses security rules — this is correct for a seed script and is why
 *   `allow write: if false` on subscriptions/addons/discounts doesn't break seeding.
 */

// ─── Admin SDK (Firestore — bypasses security rules) ─────────────────────────
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';

import * as admin from 'firebase-admin';

admin.initializeApp({ projectId: 'clinic-test-local' });
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

// ─── Client SDK (Auth only — needed to create users with passwords) ───────────
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator,
  createUserWithEmailAndPassword, updateProfile,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'test-api-key',
  authDomain: 'clinic-test-local.firebaseapp.com',
  projectId: 'clinic-test-local',
  storageBucket: 'clinic-test-local.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000',
};

const app = initializeApp(firebaseConfig, 'seed');
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic_alpine_001';

function makeDate(daysFromNow: number, hour: number): admin.firestore.Timestamp {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return Timestamp.fromDate(d);
}

async function createUser(
  email: string,
  password: string,
  displayName: string,
  role: 'owner' | 'staff' | 'patient',
  clinicId: string | null,
): Promise<string> {
  // Create the Auth user via client SDK (only way to set a password in emulator)
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  const uid = cred.user.uid;

  // Write the Firestore user doc via Admin SDK (bypasses rules)
  await db.doc(`users/${uid}`).set({
    displayName,
    email,
    role,
    clinicId,
    createdAt: Timestamp.now(),
  });

  console.log(`  ✓ Created ${role}: ${email} (uid: ${uid})`);
  return uid;
}

// ─── Main seed ────────────────────────────────────────────────────────────────

async function seed() {
  console.log('Seeding Firebase Emulator...\n');

  // Users
  console.log('Creating users...');
  const ownerId    = await createUser('sophie.owner@test.com', 'test1234', 'Sophie Moreau',     'owner',   CLINIC_ID);
  const staff1Id   = await createUser('anna.staff@test.com',   'test1234', 'Anna Kellenberger', 'staff',   CLINIC_ID);
  const staff2Id   = await createUser('marc.staff@test.com',   'test1234', 'Marc Dubois',       'staff',   CLINIC_ID);
  const patient1Id = await createUser('patient1@test.com',     'test1234', 'Léa Fontaine',      'patient', CLINIC_ID);
  const patient2Id = await createUser('patient2@test.com',     'test1234', 'Thomas Müller',     'patient', CLINIC_ID);

  // Clinic
  console.log('\nCreating clinic...');
  await db.doc(`clinics/${CLINIC_ID}`).set({
    name: 'Alpine Aesthetics Clinic',
    ownerId,
    plan: 'pro',
    seats: { used: 2, max: 5 }, // 2 staff on Pro (5 seat limit)
    addons: ['addon_storage_001'],
    activeDiscounts: ['WELCOME20'],
    createdAt: Timestamp.now(),
  });
  console.log('  ✓ Clinic: Alpine Aesthetics Clinic');

  // Subscription (Pro, active)
  console.log('\nCreating subscription...');
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 18); // 18 days left in cycle

  await db.doc(`subscriptions/${CLINIC_ID}`).set({
    clinicId: CLINIC_ID,
    plan: 'pro',
    status: 'active',
    currentPeriodEnd: Timestamp.fromDate(periodEnd),
    stripeCustomerId: 'cus_test_REPLACE_ME',
    stripeSubscriptionId: 'sub_test_REPLACE_ME',
    gracePeriodEnd: null,
  });
  console.log('  ✓ Subscription: Pro, active, 18 days remaining');

  // Add-on
  console.log('\nCreating add-on...');
  await db.doc(`addons/${CLINIC_ID}/items/addon_storage_001`).set({
    clinicId: CLINIC_ID,
    type: 'extra_storage',
    price: 19,
    active: true,
    stripeItemId: 'si_test_REPLACE_ME',
  });
  console.log('  ✓ Add-on: Extra Storage (CHF 19/mo)');

  // Discounts
  console.log('\nCreating discounts...');

  const validUntil = new Date();
  validUntil.setFullYear(validUntil.getFullYear() + 1);
  await db.doc('discounts/discount_welcome_001').set({
    code: 'WELCOME20',
    percentOff: 20,
    appliesToBase: true,
    appliesToAddons: [], // does NOT apply to add-ons — key test case for Scenario 3
    validUntil: Timestamp.fromDate(validUntil),
    usageLimit: 100,
    usedCount: 1,
  });
  console.log('  ✓ Discount: WELCOME20 — 20% off base plan (valid 1 year)');

  const expiredDate = new Date();
  expiredDate.setDate(expiredDate.getDate() - 7); // expired 7 days ago
  await db.doc('discounts/discount_addons_exp').set({
    code: 'ADDONS15',
    percentOff: 15,
    appliesToBase: false,
    appliesToAddons: 'all',
    validUntil: Timestamp.fromDate(expiredDate),
    usageLimit: 50,
    usedCount: 3,
  });
  console.log('  ✓ Discount: ADDONS15 — 15% off all add-ons (EXPIRED — for Scenario 5)');

  // Seats (Admin SDK — no auth needed, bypasses rules)
  console.log('\nCreating seats...');
  await db.doc(`seats/${CLINIC_ID}/members/${ownerId}`).set({
    role: 'owner',
    joinedAt: Timestamp.now(),
    active: true,
  });
  await db.doc(`seats/${CLINIC_ID}/members/${staff1Id}`).set({
    role: 'staff',
    joinedAt: Timestamp.now(),
    active: true,
  });
  await db.doc(`seats/${CLINIC_ID}/members/${staff2Id}`).set({
    role: 'staff',
    joinedAt: Timestamp.now(),
    active: true,
  });
  console.log('  ✓ Seats: 1 owner + 2 staff active');

  // Appointments
  console.log('\nCreating appointments...');
  await db.doc('appointments/appt_001').set({
    patientId: patient1Id,
    staffId: staff1Id,
    clinicId: CLINIC_ID,
    status: 'confirmed',
    datetime: makeDate(1, 10),
    notes: 'Initial consultation',
  });
  await db.doc('appointments/appt_002').set({
    patientId: patient2Id,
    staffId: staff2Id,
    clinicId: CLINIC_ID,
    status: 'scheduled',
    datetime: makeDate(3, 14),
    notes: null,
  });
  await db.doc('appointments/appt_003').set({
    patientId: patient1Id,
    staffId: staff1Id,
    clinicId: CLINIC_ID,
    status: 'completed',
    datetime: makeDate(-5, 9),
    notes: 'Follow-up after treatment',
  });
  await db.doc('appointments/appt_004').set({
    patientId: patient2Id,
    staffId: staff1Id,
    clinicId: CLINIC_ID,
    status: 'canceled',
    datetime: makeDate(-2, 16),
    notes: null,
  });
  console.log('  ✓ Appointments: 4 created (confirmed, scheduled, completed, canceled)');

  console.log('\n✅ Seed complete!\n');
  console.log('Test accounts (password: test1234):');
  console.log('  Owner:    sophie.owner@test.com');
  console.log('  Staff:    anna.staff@test.com');
  console.log('  Staff:    marc.staff@test.com');
  console.log('  Patient:  patient1@test.com');
  console.log('  Patient:  patient2@test.com');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
