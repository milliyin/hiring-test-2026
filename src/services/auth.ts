import { Platform } from 'react-native';
import { firebaseApp } from './firebase';

const authModule = Platform.OS === 'web' ? require('firebase/auth') : require('@react-native-firebase/auth');
const auth = Platform.OS === 'web' ? authModule.getAuth(firebaseApp) : authModule.default;

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const firestore = Platform.OS === 'web' ? firestoreModule.getFirestore(firebaseApp) : firestoreModule.default;

// ─── Firestore write helpers (platform-abstracted) ────────────────────────────

async function fsSet(path: string[], data: Record<string, unknown>): Promise<void> {
  if (Platform.OS === 'web') {
    const { doc, setDoc } = firestoreModule;
    await setDoc(doc(firestore, ...path), data);
  } else {
    const [collection, ...rest] = path;
    let ref: any = firestore.collection(collection);
    for (let i = 0; i < rest.length; i++) {
      ref = i % 2 === 0 ? ref.doc(rest[i]) : ref.collection(rest[i]);
    }
    await ref.set(data);
  }
}

function now() {
  return Platform.OS === 'web' ? firestoreModule.Timestamp.now() : firestore.Timestamp.now();
}

function futureTimestamp(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return Platform.OS === 'web'
    ? firestoreModule.Timestamp.fromDate(d)
    : firestore.Timestamp.fromDate(d);
}

// ─── Auth functions ───────────────────────────────────────────────────────────

/**
 * Creates a Firebase Auth user and all required Firestore documents.
 *
 * For owners: also creates the clinic, a Free subscription, and the owner's seat.
 * Writes are sequential — each step depends on the previous one being committed
 * so Firestore rules (which read user.role / user.clinicId in real-time) pass correctly.
 *
 * @param clinicName Required when role === 'owner'.
 */
export async function signUp(
  email: string,
  password: string,
  displayName: string,
  role: 'owner' | 'patient' = 'patient',
  clinicName?: string,
): Promise<void> {
  // 1. Create Firebase Auth user
  let uid: string;
  if (Platform.OS === 'web') {
    const credential = await authModule.createUserWithEmailAndPassword(auth, email, password);
    await authModule.updateProfile(credential.user, { displayName });
    uid = credential.user.uid;
  } else {
    const credential = await auth().createUserWithEmailAndPassword(email, password);
    await credential.user.updateProfile({ displayName });
    uid = credential.user.uid;
  }

  if (role === 'owner' && clinicName) {
    const clinicId = `clinic_${uid.slice(0, 8)}_${Date.now()}`;

    // 2. Write user doc with clinicId — must be first so subsequent rule checks pass
    await fsSet(['users', uid], {
      displayName, email, role: 'owner', clinicId, createdAt: now(),
    });

    // 3. Create the clinic
    await fsSet(['clinics', clinicId], {
      name: clinicName,
      ownerId: uid,
      plan: 'free',
      seats: { used: 0, max: 1 }, // Free plan: 1 staff seat
      addons: [],
      activeDiscounts: [],
      createdAt: now(),
    });

    // 4. Create Free subscription — must exist before seat write (clinicIsFullyActive check)
    await fsSet(['subscriptions', clinicId], {
      clinicId,
      plan: 'free',
      status: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      gracePeriodEnd: null,
      currentPeriodEnd: futureTimestamp(30),
    });

    // 5. Create owner's seat record
    await fsSet(['seats', clinicId, 'members', uid], {
      role: 'owner',
      active: true,
      joinedAt: now(),
    });

  } else {
    // Patient — no clinic association at signup
    await fsSet(['users', uid], {
      displayName, email, role: 'patient', clinicId: null, createdAt: now(),
    });
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  if (Platform.OS === 'web') {
    await authModule.signInWithEmailAndPassword(auth, email, password);
  } else {
    await auth().signInWithEmailAndPassword(email, password);
  }
}

export async function signOut(): Promise<void> {
  if (Platform.OS === 'web') {
    await authModule.signOut(auth);
  } else {
    await auth().signOut();
  }
}

// Force token refresh to pick up new custom claims (e.g., after role change)
export async function refreshAuthToken(): Promise<void> {
  if (Platform.OS === 'web') {
    await authModule.reload(auth.currentUser);
  } else {
    await auth().currentUser?.getIdToken(true);
  }
}

/**
 * Removes a staff member from the clinic and invalidates their session.
 * Delegates to the removeStaffMember Cloud Function which:
 *   1. Atomically updates Firestore (role → patient, clinicId → null, seat → inactive)
 *   2. Calls revokeRefreshTokens server-side for full token invalidation
 *
 * See DECISIONS.md — Scenario 6 for the full rationale.
 */
export async function revokeUserSession(clinicId: string, userId: string): Promise<void> {
  const { removeStaffMember } = await import('./stripe');
  await removeStaffMember(clinicId, userId);
}
