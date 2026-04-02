import { create } from 'zustand';
import { Platform } from 'react-native';
import { firebaseApp } from '@/services/firebase';
import { getUser } from '@/services/firestore';
import type { User } from '@/types/user';

const authModule = Platform.OS === 'web' ? require('firebase/auth') : require('@react-native-firebase/auth');
const auth = Platform.OS === 'web' ? authModule.getAuth(firebaseApp) : authModule.default;

// Connect emulator here — before initAuthListener — so onAuthStateChanged never fires on a
// non-emulated instance. Moving this to auth.ts is too late: auth.ts loads lazily (only when
// the login screen mounts), which is after the listener is already registered.
const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  if (Platform.OS === 'web') {
    authModule.connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  } else {
    auth().useEmulator(`http://${EMULATOR_HOST}:9099`);
  }
}

type AuthState = {
  firebaseUser: any; // Platform-specific user type
  userProfile: User | null;
  isLoading: boolean;
  setFirebaseUser: (user: any) => void;
  loadUserProfile: (uid: string) => Promise<void>;
  reset: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  firebaseUser: null,
  userProfile: null,
  isLoading: true,

  setFirebaseUser: (user) => set({ firebaseUser: user }),

  loadUserProfile: async (uid) => {
    const profile = await getUser(uid);
    set({ userProfile: profile, isLoading: false });
  },

  reset: () => set({ firebaseUser: null, userProfile: null, isLoading: false }),
}));

// Set up the Firebase Auth listener — call once at app startup
export function initAuthListener(): () => void {
  const authInstance = Platform.OS === 'web' ? auth : auth();
  return authInstance.onAuthStateChanged(async (user) => {
    const { setFirebaseUser, loadUserProfile, reset } = useAuthStore.getState();
    if (user) {
      setFirebaseUser(user);
      await loadUserProfile(user.uid);
    } else {
      reset();
    }
  });
}
