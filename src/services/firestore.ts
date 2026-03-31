import { Platform } from 'react-native';
import { firebaseApp } from './firebase';

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const firestore = Platform.OS === 'web' ? firestoreModule.getFirestore(firebaseApp) : firestoreModule.default;

import type { Clinic } from '@/types/clinic';
import type { User } from '@/types/user';
import type { Subscription } from '@/types/subscription';
import type { Appointment } from '@/types/appointment';
import type { Addon } from '@/types/subscription';
import type { Discount } from '@/types/discount';

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  if (Platform.OS === 'web') {
    const { connectFirestoreEmulator } = firestoreModule;
    connectFirestoreEmulator(firestore, EMULATOR_HOST, 8080);
  } else {
    firestore.useEmulator(EMULATOR_HOST, 8080);
  }
}

// --- Clinics ---

export function subscribeToClinic(
  clinicId: string,
  onUpdate: (clinic: Clinic) => void,
): () => void {
  if (Platform.OS === 'web') {
    const { doc, onSnapshot } = firestoreModule;
    const docRef = doc(firestore, 'clinics', clinicId);
    return onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        onUpdate({ id: snap.id, ...snap.data() } as Clinic);
      }
    });
  } else {
    return firestore
      .collection('clinics')
      .doc(clinicId)
      .onSnapshot((snap) => {
        if (snap.exists()) {
          onUpdate({ id: snap.id, ...snap.data() } as Clinic);
        }
      });
  }
}

// --- Users ---

export async function getUser(userId: string): Promise<User | null> {
  if (Platform.OS === 'web') {
    const { doc, getDoc } = firestoreModule;
    const docRef = doc(firestore, 'users', userId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as User;
  } else {
    const snap = await firestore.collection('users').doc(userId).get();
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as User;
  }
}

export async function getClinicMembers(clinicId: string): Promise<User[]> {
  if (Platform.OS === 'web') {
    const { collection, query, where, getDocs } = firestoreModule;
    const q = query(collection(firestore, 'users'), where('clinicId', '==', clinicId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() } as User));
  } else {
    const snap = await firestore
      .collection('users')
      .where('clinicId', '==', clinicId)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() } as User));
  }
}

// --- Subscriptions ---

export function subscribeToSubscription(
  clinicId: string,
  onUpdate: (sub: Subscription) => void,
): () => void {
  if (Platform.OS === 'web') {
    const { doc, onSnapshot } = firestoreModule;
    const docRef = doc(firestore, 'subscriptions', clinicId);
    return onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        onUpdate({ clinicId, ...snap.data() } as Subscription);
      }
    });
  } else {
    return firestore
      .collection('subscriptions')
      .doc(clinicId)
      .onSnapshot((snap) => {
        if (snap.exists()) {
          onUpdate({ clinicId, ...snap.data() } as Subscription);
        }
      });
  }
}

// --- Appointments ---

export function subscribeToClinicAppointments(
  clinicId: string,
  onUpdate: (appointments: Appointment[]) => void,
): () => void {
  if (Platform.OS === 'web') {
    const { collection, query, where, orderBy, onSnapshot } = firestoreModule;
    const q = query(collection(firestore, 'appointments'), where('clinicId', '==', clinicId), orderBy('datetime', 'asc'));
    return onSnapshot(q, (snap) => {
      const appointments = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Appointment));
      onUpdate(appointments);
    });
  } else {
    return firestore
      .collection('appointments')
      .where('clinicId', '==', clinicId)
      .orderBy('datetime', 'asc')
      .onSnapshot((snap) => {
        const appointments = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Appointment));
        onUpdate(appointments);
      });
  }
}

export function subscribeToPatientAppointments(
  patientId: string,
  onUpdate: (appointments: Appointment[]) => void,
): () => void {
  if (Platform.OS === 'web') {
    const { collection, query, where, orderBy, onSnapshot } = firestoreModule;
    const q = query(collection(firestore, 'appointments'), where('patientId', '==', patientId), orderBy('datetime', 'asc'));
    return onSnapshot(q, (snap) => {
      const appointments = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Appointment));
      onUpdate(appointments);
    });
  } else {
    return firestore
      .collection('appointments')
      .where('patientId', '==', patientId)
      .orderBy('datetime', 'asc')
      .onSnapshot((snap) => {
        const appointments = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Appointment));
        onUpdate(appointments);
      });
  }
}

// --- Add-ons ---

export async function getClinicAddons(clinicId: string): Promise<Addon[]> {
  if (Platform.OS === 'web') {
    const { collection, doc, query, where, getDocs } = firestoreModule;
    const q = query(collection(firestore, 'addons', clinicId, 'items'), where('active', '==', true));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, clinicId, ...d.data() } as Addon));
  } else {
    const snap = await firestore
      .collection('addons')
      .doc(clinicId)
      .collection('items')
      .where('active', '==', true)
      .get();
    return snap.docs.map((d) => ({ id: d.id, clinicId, ...d.data() } as Addon));
  }
}

// --- Discounts ---

export async function getClinicDiscounts(clinicId: string): Promise<Discount[]> {
  if (Platform.OS === 'web') {
    const { doc, getDoc, collection, query, where, getDocs } = firestoreModule;
    const clinicDocRef = doc(firestore, 'clinics', clinicId);
    const clinicSnap = await getDoc(clinicDocRef);
    const clinic = clinicSnap.data() as Clinic;
    if (!clinic?.activeDiscounts?.length) return [];

    const discountDocs = await Promise.all(
      clinic.activeDiscounts.map((code) => {
        const q = query(collection(firestore, 'discounts'), where('code', '==', code));
        return getDocs(q).then(snap => snap.docs[0]);
      })
    );

    return discountDocs
      .filter(d => d)
      .map((d) => ({ id: d.id, ...d.data() } as Discount));
  } else {
    // Fetch discounts referenced by the clinic's activeDiscounts array
    const clinicSnap = await firestore.collection('clinics').doc(clinicId).get();
    const clinic = clinicSnap.data() as Clinic;
    if (!clinic?.activeDiscounts?.length) return [];

    const discountDocs = await Promise.all(
      clinic.activeDiscounts.map((code) =>
        firestore.collection('discounts').where('code', '==', code).limit(1).get(),
      ),
    );

    return discountDocs
      .flatMap((snap) => snap.docs)
      .map((d) => ({ id: d.id, ...d.data() } as Discount));
  }
}
