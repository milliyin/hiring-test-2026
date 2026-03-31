import { Platform } from 'react-native';

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const Timestamp = Platform.OS === 'web' ? firestoreModule.Timestamp : firestoreModule.default.Timestamp;

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'canceled';

export type Appointment = {
  id: string;
  patientId: string;
  staffId: string;
  clinicId: string;
  status: AppointmentStatus;
  datetime: Timestamp;
  notes: string | null;
  // TODO [CHALLENGE]: Add attachments field — only available with extra_storage add-on
  // attachments?: string[]; // storage URLs
};
