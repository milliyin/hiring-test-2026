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
  attachments?: string[]; // storage URLs — only populated when extra_storage add-on is active
};
