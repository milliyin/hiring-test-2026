import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, TextInput,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { useClinic } from '@/hooks/useClinic';
import { useSubscription } from '@/hooks/useSubscription';
import { getClinicMembers } from '@/services/firestore';
import { revokeUserSession } from '@/services/auth';
import { inviteStaff } from '@/services/stripe';
import { SeatUsageBar } from '@/components/SeatUsageBar';
import type { User } from '@/types/user';

export default function StaffScreen() {
  const { isOwner } = useAuth();
  const { clinic } = useClinic();
  const { seatsUsed, seatsMax, canAddStaff, isGracePeriod } = useSubscription();
  const [members, setMembers] = useState<User[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteCredentials, setInviteCredentials] = useState<{ email: string; tempPassword: string } | null>(null);

  useEffect(() => {
    if (!clinic || !isOwner) return;
    getClinicMembers(clinic.id).then((all) =>
      setMembers(all.filter((u) => u.role === 'staff' || u.role === 'owner')),
    );
  }, [clinic?.id, isOwner]);

  if (!isOwner) {
    return (
      <View style={styles.restricted}>
        <Text style={styles.restrictedText}>Staff management is only visible to clinic owners.</Text>
      </View>
    );
  }

  function handleInviteStaff() {
    if (!canAddStaff) {
      Alert.alert(
        isGracePeriod ? 'Billing issue' : 'Seat limit reached',
        isGracePeriod
          ? 'Resolve your billing issue before adding new staff.'
          : 'Upgrade your plan or purchase the Extra Seats add-on.',
      );
      return;
    }
    setInviteName('');
    setInviteEmail('');
    setInviteCredentials(null);
    setShowInviteForm(true);
  }

  async function handleSendInvite() {
    if (!clinic || !inviteName.trim() || !inviteEmail.trim()) return;
    setInviting(true);
    try {
      const { tempPassword } = await inviteStaff({
        clinicId: clinic.id,
        email: inviteEmail.trim().toLowerCase(),
        displayName: inviteName.trim(),
      });
      setInviteCredentials({ email: inviteEmail.trim().toLowerCase(), tempPassword });
      getClinicMembers(clinic.id)
        .then((all) => setMembers(all.filter((u) => u.role === 'staff' || u.role === 'owner')))
        .catch(() => {});
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Failed to invite staff member.';
      Alert.alert('Invite failed', msg);
    } finally {
      setInviting(false);
    }
  }

  function handleRemoveStaff(userId: string) {
    setConfirmingId(userId);
  }

  async function confirmRemove(userId: string) {
    if (!clinic) return;
    setConfirmingId(null);
    setRemovingId(userId);
    try {
      await revokeUserSession(clinic.id, userId);
      const updated = await getClinicMembers(clinic.id);
      setMembers(updated.filter((u) => u.role === 'staff' || u.role === 'owner'));
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Failed to remove staff member.';
      Alert.alert('Error', msg);
    } finally {
      setRemovingId(null);
    }
  }

  function renderMember({ item }: { item: User }) {
    const isCurrentUserOwner = item.role === 'owner';
    return (
      <View style={styles.memberRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{item.displayName.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.memberInfo}>
          <Text style={styles.memberName}>{item.displayName}</Text>
          <Text style={styles.memberEmail}>{item.email}</Text>
        </View>
        <View style={styles.memberRight}>
          <View style={[styles.roleBadge, isCurrentUserOwner && styles.roleBadgeOwner]}>
            <Text style={[styles.roleText, isCurrentUserOwner && styles.roleTextOwner]}>
              {item.role}
            </Text>
          </View>
          {isOwner && !isCurrentUserOwner && (
            removingId === item.id
              ? <ActivityIndicator size="small" color="#ef4444" />
              : confirmingId === item.id
                ? (
                  <View style={styles.confirmRow}>
                    <TouchableOpacity onPress={() => confirmRemove(item.id)}>
                      <Text style={styles.confirmYes}>Confirm</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setConfirmingId(null)}>
                      <Text style={styles.confirmNo}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                )
                : (
                  <TouchableOpacity onPress={() => handleRemoveStaff(item.id)}>
                    <Text style={styles.removeButton}>Remove</Text>
                  </TouchableOpacity>
                )
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SeatUsageBar used={seatsUsed} max={seatsMax} />

        {isOwner && !showInviteForm && (
          <TouchableOpacity
            style={[styles.inviteButton, !canAddStaff && styles.inviteButtonDisabled]}
            onPress={handleInviteStaff}
          >
            <Text style={styles.inviteText}>+ Invite staff</Text>
          </TouchableOpacity>
        )}

        {/* Inline invite form — no Modal, avoids web rendering issues */}
        {showInviteForm && (
          <View style={styles.inviteForm}>
            {inviteCredentials ? (
              // Success: show credentials for the owner to share
              <>
                <Text style={styles.inviteFormTitle}>Staff invited!</Text>
                <Text style={styles.inviteFormLabel}>Share these login details:</Text>
                <View style={styles.credBox}>
                  <Text style={styles.credLine}>Email: <Text style={styles.credValue}>{inviteCredentials.email}</Text></Text>
                  <Text style={styles.credLine}>Temp password: <Text style={styles.credValue}>{inviteCredentials.tempPassword}</Text></Text>
                </View>
                <Text style={styles.inviteFormHint}>They should change their password after first login.</Text>
                <TouchableOpacity style={styles.inviteButton} onPress={() => setShowInviteForm(false)}>
                  <Text style={styles.inviteText}>Done</Text>
                </TouchableOpacity>
              </>
            ) : (
              // Input form
              <>
                <Text style={styles.inviteFormTitle}>Invite a staff member</Text>
                <TextInput
                  style={styles.inviteInput}
                  placeholder="Full name"
                  value={inviteName}
                  onChangeText={setInviteName}
                  returnKeyType="next"
                  blurOnSubmit={false}
                />
                <TextInput
                  style={styles.inviteInput}
                  placeholder="Email address"
                  value={inviteEmail}
                  onChangeText={setInviteEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  returnKeyType="go"
                  onSubmitEditing={handleSendInvite}
                />
                <View style={styles.inviteActions}>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => setShowInviteForm(false)}
                    disabled={inviting}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.inviteButton, styles.inviteButtonFlex,
                      (!inviteName.trim() || !inviteEmail.trim() || inviting) && styles.inviteButtonDisabled]}
                    onPress={handleSendInvite}
                    disabled={!inviteName.trim() || !inviteEmail.trim() || inviting}
                  >
                    {inviting
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={styles.inviteText}>Send invite</Text>
                    }
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        )}
      </View>

      <FlatList
        data={members}
        keyExtractor={(item) => item.id}
        renderItem={renderMember}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>No staff members yet.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    backgroundColor: '#fff',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  inviteButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  inviteButtonDisabled: { backgroundColor: '#9ca3af' },
  inviteText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  list: { padding: 16 },
  memberRow: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#dbeafe',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: '#1e40af' },
  memberInfo: { flex: 1 },
  memberName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  memberEmail: { fontSize: 13, color: '#6b7280' },
  memberRight: { alignItems: 'flex-end' },
  roleBadge: {
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  roleBadgeOwner: { backgroundColor: '#fef3c7' },
  roleText: { fontSize: 11, fontWeight: '700', color: '#374151' },
  roleTextOwner: { color: '#92400e' },
  removeButton: { fontSize: 13, color: '#ef4444', fontWeight: '600' },
  confirmRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  confirmYes: { fontSize: 13, color: '#ef4444', fontWeight: '700' },
  confirmNo: { fontSize: 13, color: '#6b7280', fontWeight: '600' },
  empty: { fontSize: 14, color: '#9ca3af', textAlign: 'center', marginTop: 32 },
  restricted: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  restrictedText: { fontSize: 16, color: '#6b7280', textAlign: 'center' },
  inviteForm: {
    marginTop: 12, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 12,
  },
  inviteFormTitle: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 10 },
  inviteFormLabel: { fontSize: 13, color: '#6b7280', marginBottom: 8 },
  inviteFormHint: { fontSize: 12, color: '#9ca3af', marginBottom: 10 },
  inviteInput: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    padding: 10, fontSize: 14, color: '#111827', marginBottom: 8, backgroundColor: '#fff',
  },
  inviteActions: { flexDirection: 'row', gap: 8 },
  inviteButtonFlex: { flex: 1 },
  cancelButton: {
    flex: 1, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    padding: 12, alignItems: 'center',
  },
  cancelText: { color: '#374151', fontWeight: '600', fontSize: 14 },
  credBox: {
    backgroundColor: '#f9fafb', borderRadius: 8, padding: 12, marginBottom: 8,
  },
  credLine: { fontSize: 13, color: '#6b7280', marginBottom: 4 },
  credValue: { fontWeight: '700', color: '#111827', fontFamily: 'monospace' },
});
