import { Platform } from 'react-native';
import { firebaseApp } from './firebase';

const authModule = Platform.OS === 'web' ? require('firebase/auth') : require('@react-native-firebase/auth');
const auth = Platform.OS === 'web' ? authModule.getAuth(firebaseApp) : authModule.default;

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const firestore = Platform.OS === 'web' ? firestoreModule.getFirestore(firebaseApp) : firestoreModule.default;

import type { User } from '@/types/user';

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  if (Platform.OS === 'web') {
    const { connectAuthEmulator } = authModule;
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`);
  } else {
    auth().useEmulator(`http://${EMULATOR_HOST}:9099`);
  }
}

export async function signUp(
  email: string,
  password: string,
  displayName: string,
  role: 'owner' | 'patient' = 'patient',
): Promise<void> {
  alert('Starting signup for ' + email);
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

  await firestore.collection('users').doc(credential.user.uid).set(userData);
  alert('Signup successful');
}

export async function signIn(email: string, password: string): Promise<void> {
  alert('Starting sign in for ' + email);
  if (Platform.OS === 'web') {
    await authModule.signInWithEmailAndPassword(auth, email, password);
  } else {
    await auth().signInWithEmailAndPassword(email, password);
  }
  alert('Sign in successful');
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

// TODO [CHALLENGE]: Implement session invalidation for removed staff (Scenario 6).
// When an owner removes a staff member, their Firebase Auth session on their device
// is still valid. Options:
//   A) Revoke refresh tokens server-side (Firebase Admin SDK — requires Cloud Function)
//   B) Check Firestore on every protected action — if user.active === false, block access
//   C) Use custom claims to set a 'disabled' flag and check it in Firestore rules
//
// Whichever approach you choose, document WHY in DECISIONS.md.
// The Firestore rule in seats/ is intentionally incomplete — your implementation goes there.
export async function revokeUserSession(_userId: string): Promise<void> {
  throw new Error('TODO [CHALLENGE]: Implement revokeUserSession via Cloud Function');
}
