import { Platform } from 'react-native';

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const Timestamp = Platform.OS === 'web' ? firestoreModule.Timestamp : firestoreModule.default.Timestamp;

export type UserRole = 'owner' | 'staff' | 'patient';

export type User = {
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
  clinicId: string | null; // null for patients not yet associated
  createdAt: Timestamp;
};
