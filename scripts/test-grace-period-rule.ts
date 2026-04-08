/**
 * Tests that Firestore rules block new staff seats during grace_period.
 *
 * Requires:
 *   - Firebase emulators running (firebase emulators:start)
 *   - subscriptions/clinic_alpine_001 status set to "grace_period" in emulator UI
 *
 * Run: npx ts-node scripts/test-grace-period-rule.ts
 */

import { initializeApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator,
  doc, setDoc,
} from 'firebase/firestore';
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword,
} from 'firebase/auth';

const app = initializeApp({
  apiKey: 'test-api-key',
  authDomain: 'clinic-test-local.firebaseapp.com',
  projectId: 'clinic-test-local',
}, 'rule-test');

const auth = getAuth(app);
const db = getFirestore(app);

connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
connectFirestoreEmulator(db, 'localhost', 8080);

async function run() {
  // Sign in as the owner
  await signInWithEmailAndPassword(auth, 'sophie.owner@test.com', 'test1234');
  console.log('Signed in as owner\n');

  const newSeatRef = doc(db, 'seats/clinic_alpine_001/members/test_new_staff');

  // ── Test 1: should be DENIED during grace_period ──────────────────────────
  console.log('Test 1 — write active seat during grace_period (expect: DENIED)');
  try {
    await setDoc(newSeatRef, { role: 'staff', active: true });
    console.log('  FAIL — write succeeded (rule not enforced!)\n');
  } catch (e: unknown) {
    const msg = (e as { code?: string }).code ?? String(e);
    if (msg.includes('permission-denied')) {
      console.log('  PASS — correctly denied\n');
    } else {
      console.log(`  ERROR — unexpected error: ${msg}\n`);
    }
  }

  // ── Test 2: deactivating a seat should still be ALLOWED ───────────────────
  console.log('Test 2 — deactivate existing seat during grace_period (expect: ALLOWED)');
  // First set it to inactive state (which should always be allowed)
  try {
    await setDoc(newSeatRef, { role: 'staff', active: false });
    console.log('  PASS — deactivation allowed\n');
  } catch (e: unknown) {
    const msg = (e as { code?: string }).code ?? String(e);
    console.log(`  FAIL — deactivation was denied: ${msg}\n`);
  }

  console.log('Done. Now set subscription status back to "active" and re-run to confirm writes are allowed again.');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
