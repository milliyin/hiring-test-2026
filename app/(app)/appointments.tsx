import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { useClinic } from '@/hooks/useClinic';
import {
  subscribeToClinicAppointments,
  subscribeToPatientAppointments,
} from '@/services/firestore';
import type { Appointment } from '@/types/appointment';
import type { User } from '@/types/user';
import { getClinicMembers } from '@/services/firestore';
import { format } from 'date-fns';

export default function AppointmentsScreen() {
  const { profile, isStaff, isPatient } = useAuth();
  const { clinic } = useClinic();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [memberMap, setMemberMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!profile) return;

    let unsubscribe: (() => void) | undefined;

    if (isStaff && clinic) {
      unsubscribe = subscribeToClinicAppointments(clinic.id, setAppointments);
    } else if (isPatient) {
      unsubscribe = subscribeToPatientAppointments(profile.id, setAppointments);
    }

    return () => unsubscribe?.();
  }, [profile?.id, clinic?.id, isStaff, isPatient]);

  useEffect(() => {
    if (!clinic) return;
    getClinicMembers(clinic.id).then((members) => {
      const map: Record<string, string> = {};
      members.forEach((m) => { map[m.id] = m.displayName; });
      setMemberMap(map);
    });
  }, [clinic?.id]);

  function renderAppointment({ item }: { item: Appointment }) {
    const dt = item.datetime.toDate();
    return (
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <Text style={styles.date}>{format(dt, 'EEE d MMM')}</Text>
          <Text style={[styles.status, styles[`status_${item.status}`]]}>
            {item.status}
          </Text>
        </View>
        <Text style={styles.time}>{format(dt, 'HH:mm')}</Text>
        {isStaff && (
          <Text style={styles.meta}>Patient: {item.patientId}</Text>
        )}
        {isPatient && (
          <Text style={styles.meta}>Staff: {memberMap[item.staffId] ?? item.staffId}</Text>
        )}
        {/* TODO [CHALLENGE]: Show attachments if extra_storage add-on is active */}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {appointments.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No appointments yet.</Text>
          {isPatient && (
            <Text style={styles.emptyHint}>Contact your clinic to book an appointment.</Text>
          )}
        </View>
      ) : (
        <FlatList
          data={appointments}
          keyExtractor={(item) => item.id}
          renderItem={renderAppointment}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => setRefreshing(false)} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  list: { padding: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    marginBottom: 12,
  },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  date: { fontSize: 15, fontWeight: '600', color: '#111827' },
  time: { fontSize: 14, color: '#6b7280' },
  meta: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  status: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  status_scheduled: { backgroundColor: '#dbeafe', color: '#1e40af' },
  status_confirmed: { backgroundColor: '#d1fae5', color: '#065f46' },
  status_completed: { backgroundColor: '#f3f4f6', color: '#374151' },
  status_canceled:  { backgroundColor: '#fee2e2', color: '#991b1b' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyText: { fontSize: 17, fontWeight: '600', color: '#374151', marginBottom: 8 },
  emptyHint: { fontSize: 14, color: '#9ca3af', textAlign: 'center' },
});
