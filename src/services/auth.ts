import { Platform } from 'react-native';
import { firebaseApp } from './firebase';

const authModule = Platform.OS === 'web' ? require('firebase/auth') : require('@react-native-firebase/auth');
const auth = Platform.OS === 'web' ? authModule.getAuth(firebaseApp) : authModule.default;

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const firestore = Platform.OS === 'web' ? firestoreModule.getFirestore(firebaseApp) : firestoreModule.default;

import type { User } from '@/types/user';

export async function signUp(
  email: string,
  password: string,
  displayName: string,
  role: 'owner' | 'patient' = 'patient',
): Promise<void> {
  let credential;
  if (Platform.OS === 'web') {
    credential = await authModule.createUserWithEmailAndPassword(auth, email, password);
    await authModule.updateProfile(credential.user, { displayName });
  } else {
    credential = await auth().createUserWithEmailAndPassword(email, password);
    await credential.user.updateProfile({ displayName });
  }

  // Write user doc to Firestore
  const userData: Omit<User, 'id'> = {
    displayName,
    email,
    role,
    clinicId: null,
    createdAt: Platform.OS === 'web' ? firestoreModule.Timestamp.now() : firestore.Timestamp.now(),
  };

  if (Platform.OS === 'web') {
    const { doc, setDoc } = firestoreModule;
    await setDoc(doc(firestore, 'users', credential.user.uid), userData);
  } else {
    await firestore.collection('users').doc(credential.user.uid).set(userData);
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
// Call this after any server-side role update.
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
