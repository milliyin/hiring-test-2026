import { Platform } from 'react-native';

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const Timestamp = Platform.OS === 'web' ? firestoreModule.Timestamp : firestoreModule.default.Timestamp;

export type SeatInfo = {
  used: number;
  max: number; // base plan limit + extra seat add-ons
};

export type Clinic = {
  id: string;
  name: string;
  ownerId: string;
  plan: string; // mirrors subscriptions/{clinicId}.plan for quick reads
  seats: SeatInfo;
  addons: string[]; // active addon IDs
  activeDiscounts: string[]; // active discount codes
  createdAt: Timestamp;
};
