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
 */

import { initializeApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator,
  collection, doc, setDoc, Timestamp,
} from 'firebase/firestore';
import {
  getAuth, connectAuthEmulator,
  createUserWithEmailAndPassword, updateProfile,signInWithEmailAndPassword,
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
const db = getFirestore(app);

connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
connectFirestoreEmulator(db, 'localhost', 8080);

const CLINIC_ID = 'clinic_alpine_001';

async function createUser(
  email: string,
  password: string,
  displayName: string,
  role: 'owner' | 'staff' | 'patient',
  clinicId: string | null,
): Promise<string> {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });

  await setDoc(doc(db, 'users', cred.user.uid), {
    displayName,
    email,
    role,
    clinicId,
    createdAt: Timestamp.now(),
  });

  console.log(`  ✓ Created ${role}: ${email} (uid: ${cred.user.uid})`);
  return cred.user.uid;
}

async function seed() {
  console.log('Seeding Firebase Emulator...\n');

  // Users
  console.log('Creating users...');
  const ownerId   = await createUser('sophie.owner@test.com', 'test1234', 'Sophie Moreau',     'owner',   CLINIC_ID);
  const staff1Id  = await createUser('anna.staff@test.com',   'test1234', 'Anna Kellenberger', 'staff',   CLINIC_ID);
  const staff2Id  = await createUser('marc.staff@test.com',   'test1234', 'Marc Dubois',       'staff',   CLINIC_ID);
  const patient1Id = await createUser('patient1@test.com',    'test1234', 'Léa Fontaine',      'patient', CLINIC_ID);
  const patient2Id = await createUser('patient2@test.com',    'test1234', 'Thomas Müller',     'patient', CLINIC_ID);

  // Clinic
  console.log('\nCreating clinic...');
  await setDoc(doc(db, 'clinics', CLINIC_ID), {
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

  await setDoc(doc(db, 'subscriptions', CLINIC_ID), {
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
  await setDoc(doc(db, 'addons', CLINIC_ID, 'items', 'addon_storage_001'), {
    clinicId: CLINIC_ID,
    type: 'extra_storage',
    price: 19,
    active: true,
    stripeItemId: 'si_test_REPLACE_ME',
  });
  console.log('  ✓ Add-on: Extra Storage (CHF 19/mo)');

  // Discounts
  console.log('\nCreating discounts...');

  // Active discount — applies to base plan only
  const validUntil = new Date();
  validUntil.setFullYear(validUntil.getFullYear() + 1);
  await setDoc(doc(db, 'discounts', 'discount_welcome_001'), {
    code: 'WELCOME20',
    percentOff: 20,
    appliesToBase: true,
    appliesToAddons: [], // does NOT apply to add-ons — key test case for Scenario 3
    validUntil: Timestamp.fromDate(validUntil),
    usageLimit: 100,
    usedCount: 1,
  });
  console.log('  ✓ Discount: WELCOME20 — 20% off base plan (valid 1 year)');

  // Expired discount — 15% off all add-ons (for Scenario 5)
  const expiredDate = new Date();
  expiredDate.setDate(expiredDate.getDate() - 7); // expired 7 days ago
  await setDoc(doc(db, 'discounts', 'discount_addons_exp'), {
    code: 'ADDONS15',
    percentOff: 15,
    appliesToBase: false,
    appliesToAddons: 'all',
    validUntil: Timestamp.fromDate(expiredDate),
    usageLimit: 50,
    usedCount: 3,
  });
  console.log('  ✓ Discount: ADDONS15 — 15% off all add-ons (EXPIRED — for Scenario 5)');

  // Seats
  console.log('\nCreating seats...');
  await setDoc(doc(db, 'seats', CLINIC_ID, 'members', ownerId), {
    role: 'owner',
    joinedAt: Timestamp.now(),
    active: true,
  });
  await setDoc(doc(db, 'seats', CLINIC_ID, 'members', staff1Id), {
    role: 'staff',
    joinedAt: Timestamp.now(),
    active: true,
  });
  await setDoc(doc(db, 'seats', CLINIC_ID, 'members', staff2Id), {
    role: 'staff',
    joinedAt: Timestamp.now(),
    active: true,
  });
  console.log('  ✓ Seats: 1 owner + 2 staff active');

  // Appointments
  console.log('\nCreating appointments...');
  await signInWithEmailAndPassword(auth, 'sophie.owner@test.com', 'test1234');
  const makeDate = (daysFromNow: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(hour, 0, 0, 0);
    return Timestamp.fromDate(d);
  };

  await setDoc(doc(db, 'appointments', 'appt_001'), {
    patientId: patient1Id,
    staffId: staff1Id,
    clinicId: CLINIC_ID,
    status: 'confirmed',
    datetime: makeDate(1, 10),
    notes: 'Initial consultation',
  });
  await setDoc(doc(db, 'appointments', 'appt_002'), {
    patientId: patient2Id,
    staffId: staff2Id,
    clinicId: CLINIC_ID,
    status: 'scheduled',
    datetime: makeDate(3, 14),
    notes: null,
  });
  await setDoc(doc(db, 'appointments', 'appt_003'), {
    patientId: patient1Id,
    staffId: staff1Id,
    clinicId: CLINIC_ID,
    status: 'completed',
    datetime: makeDate(-5, 9),
    notes: 'Follow-up after treatment',
  });
  await setDoc(doc(db, 'appointments', 'appt_004'), {
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
