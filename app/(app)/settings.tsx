import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, Linking, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/hooks/useAuth';
import { useClinic } from '@/hooks/useClinic';
import { useSubscription } from '@/hooks/useSubscription';
import { signOut } from '@/services/auth';
import { createCheckoutSession, initiateDowngrade } from '@/services/stripe';
import { Platform } from 'react-native';
import { PlanBadge } from '@/components/PlanBadge';
import { PLAN_CONFIG } from '@/types/subscription';
import type { Plan } from '@/types/subscription';

const UPGRADE_OPTIONS: Plan[] = ['pro', 'premium', 'vip'];
const DOWNGRADE_OPTIONS: Plan[] = ['free', 'pro', 'premium'];

export default function SettingsScreen() {
  const { profile } = useAuth();
  const { clinic } = useClinic();
  const { plan, status } = useSubscription();
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [isDowngrading, setIsDowngrading] = useState(false);
  const [downgradeMessage, setDowngradeMessage] = useState<{ type: 'error' | 'conflict' | 'success'; text: string } | null>(null);
  const [confirmingDowngrade, setConfirmingDowngrade] = useState<Plan | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleChangePassword() {
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ ok: false, text: 'Passwords do not match.' });
      return;
    }
    if (newPassword.length < 6) {
      setPasswordMessage({ ok: false, text: 'Password must be at least 6 characters.' });
      return;
    }
    setChangingPassword(true);
    try {
      if (Platform.OS === 'web') {
        const { getAuth, updatePassword } = require('firebase/auth');
        const user = getAuth().currentUser;
        await updatePassword(user, newPassword);
      } else {
        const auth = require('@react-native-firebase/auth').default;
        await auth().currentUser?.updatePassword(newPassword);
      }
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({ ok: true, text: 'Password updated successfully.' });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      const msg = code === 'auth/requires-recent-login'
        ? 'Please sign out and sign in again before changing your password.'
        : (err as { message?: string })?.message ?? 'Failed to update password.';
      setPasswordMessage({ ok: false, text: msg });
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.replace('/(auth)/login');
  }

  async function handleUpgrade(targetPlan: Plan) {
    if (!clinic || isUpgrading) return;
    setIsUpgrading(true);
    try {
      const { url } = await createCheckoutSession({
        clinicId: clinic.id,
        plan: targetPlan as 'pro' | 'premium' | 'vip',
      });
      await Linking.openURL(url);
    } catch {
      Alert.alert('Error', 'Could not start checkout. Please try again.');
    } finally {
      setIsUpgrading(false);
    }
  }

  async function handleDowngrade(targetPlan: Plan) {
    if (!clinic || isDowngrading) return;
    setConfirmingDowngrade(null);
    setIsDowngrading(true);
    setDowngradeMessage(null);
    try {
      await initiateDowngrade({ clinicId: clinic.id, targetPlan: targetPlan as 'free' | 'pro' | 'premium' });
      setDowngradeMessage({ type: 'success', text: `Downgraded to ${targetPlan}. Changes take effect shortly.` });
    } catch (err: unknown) {
      const raw = (err as { message?: string })?.message ?? '';
      console.error('[handleDowngrade] error:', err);
      if (raw.toLowerCase().includes('seat')) {
        setDowngradeMessage({ type: 'conflict', text: raw + '\n\nRemove staff members first, then try again.' });
      } else {
        setDowngradeMessage({ type: 'error', text: raw || 'Could not downgrade plan. Check console for details.' });
      }
    } finally {
      setIsDowngrading(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Account info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Text style={styles.name}>{profile?.displayName}</Text>
        <Text style={styles.email}>{profile?.email}</Text>
        <View style={styles.roleRow}>
          <Text style={styles.roleLabel}>Role:</Text>
          <Text style={styles.roleValue}>{profile?.role}</Text>
        </View>

        {!showChangePassword ? (
          <TouchableOpacity style={styles.changePasswordLink} onPress={() => setShowChangePassword(true)}>
            <Text style={styles.changePasswordText}>Change password</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.changePasswordForm}>
            {passwordMessage && (
              <Text style={[styles.passwordMsg, passwordMessage.ok ? styles.passwordMsgOk : styles.passwordMsgErr]}>
                {passwordMessage.text}
              </Text>
            )}
            <TextInput
              style={styles.passwordInput}
              placeholder="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              returnKeyType="next"
              blurOnSubmit={false}
            />
            <TextInput
              style={styles.passwordInput}
              placeholder="Confirm new password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={handleChangePassword}
            />
            <View style={styles.passwordActions}>
              <TouchableOpacity style={styles.cancelPasswordButton} onPress={() => { setShowChangePassword(false); setNewPassword(''); setConfirmPassword(''); }}>
                <Text style={styles.cancelPasswordText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.savePasswordButton, changingPassword && { opacity: 0.5 }]}
                onPress={handleChangePassword}
                disabled={changingPassword}
              >
                <Text style={styles.savePasswordText}>{changingPassword ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* Clinic info */}
      {clinic && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Clinic</Text>
          <Text style={styles.clinicName}>{clinic.name}</Text>
          <View style={styles.planRow}>
            <PlanBadge plan={plan} />
            <Text style={styles.planStatus}>{status}</Text>
          </View>
        </View>
      )}

      {/* Plan management (owner only) */}
      {profile?.role === 'owner' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Plan management</Text>
          <Text style={styles.hint}>
            Upgrades take effect immediately. Downgrades may be queued if you have active staff
            exceeding the target plan's seat limit.
          </Text>

          <Text style={styles.subTitle}>Upgrade to</Text>
          {UPGRADE_OPTIONS.filter((p) => {
            const planOrder: Plan[] = ['free', 'pro', 'premium', 'vip'];
            return planOrder.indexOf(p) > planOrder.indexOf(plan);
          }).map((targetPlan) => (
            <TouchableOpacity
              key={targetPlan}
              style={[styles.planButton, isUpgrading && { opacity: 0.5 }]}
              onPress={() => handleUpgrade(targetPlan)}
              disabled={isUpgrading}
            >
              <View>
                <Text style={styles.planButtonName}>{PLAN_CONFIG[targetPlan].label}</Text>
                <Text style={styles.planButtonPrice}>
                  CHF {PLAN_CONFIG[targetPlan].price}/mo · {PLAN_CONFIG[targetPlan].seats === Infinity ? 'Unlimited' : PLAN_CONFIG[targetPlan].seats} seats
                </Text>
              </View>
              <Text style={styles.planButtonAction}>Upgrade →</Text>
            </TouchableOpacity>
          ))}

          {plan !== 'free' && (
            <>
              <Text style={[styles.subTitle, { marginTop: 16 }]}>Downgrade to</Text>
              {downgradeMessage && (
                <View style={[
                  styles.messageBanner,
                  downgradeMessage.type === 'success' && styles.messageBannerSuccess,
                  downgradeMessage.type === 'conflict' && styles.messageBannerConflict,
                  downgradeMessage.type === 'error' && styles.messageBannerError,
                ]}>
                  <Text style={styles.messageBannerText}>{downgradeMessage.text}</Text>
                </View>
              )}
              {DOWNGRADE_OPTIONS.filter((p) => {
                const planOrder: Plan[] = ['free', 'pro', 'premium', 'vip'];
                return planOrder.indexOf(p) < planOrder.indexOf(plan);
              }).map((targetPlan) => (
                <View key={targetPlan}>
                  <TouchableOpacity
                    style={[styles.planButton, styles.planButtonDowngrade, isDowngrading && { opacity: 0.5 }]}
                    onPress={() => setConfirmingDowngrade(confirmingDowngrade === targetPlan ? null : targetPlan)}
                    disabled={isDowngrading}
                  >
                    <View>
                      <Text style={styles.planButtonName}>{PLAN_CONFIG[targetPlan].label}</Text>
                      <Text style={styles.planButtonPrice}>
                        {PLAN_CONFIG[targetPlan].price === 0 ? 'Free' : `CHF ${PLAN_CONFIG[targetPlan].price}/mo`}
                        {' · '}
                        {PLAN_CONFIG[targetPlan].seats === Infinity ? 'Unlimited' : PLAN_CONFIG[targetPlan].seats} seats
                      </Text>
                    </View>
                    <Text style={[styles.planButtonAction, styles.downgradeText]}>Downgrade</Text>
                  </TouchableOpacity>
                  {confirmingDowngrade === targetPlan && (
                    <View style={styles.confirmDowngradeBox}>
                      <Text style={styles.confirmDowngradeText}>
                        Downgrade to {PLAN_CONFIG[targetPlan].label}? This takes effect immediately.
                      </Text>
                      <View style={styles.confirmDowngradeActions}>
                        <TouchableOpacity
                          style={styles.confirmDowngradeCancel}
                          onPress={() => setConfirmingDowngrade(null)}
                        >
                          <Text style={styles.confirmDowngradeCancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.confirmDowngradeConfirm}
                          onPress={() => handleDowngrade(targetPlan)}
                          disabled={isDowngrading}
                        >
                          <Text style={styles.confirmDowngradeConfirmText}>
                            {isDowngrading ? 'Processing...' : 'Confirm'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>
              ))}
            </>
          )}
        </View>
      )}

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, paddingBottom: 40 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  name: { fontSize: 18, fontWeight: '700', color: '#111827' },
  email: { fontSize: 14, color: '#6b7280' },
  roleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  roleLabel: { fontSize: 14, color: '#6b7280' },
  roleValue: { fontSize: 14, fontWeight: '600', color: '#374151' },
  clinicName: { fontSize: 18, fontWeight: '700', color: '#111827' },
  planRow: { flexDirection: 'row', alignItems: 'center' },
  planStatus: { fontSize: 13, color: '#6b7280' },
  hint: { fontSize: 13, color: '#6b7280', lineHeight: 18 },
  subTitle: { fontSize: 14, fontWeight: '600', color: '#374151', marginTop: 8 },
  planButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderWidth: 1,
    borderColor: '#dbeafe',
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    marginTop: 6,
  },
  planButtonDowngrade: {
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  planButtonName: { fontSize: 15, fontWeight: '700', color: '#111827' },
  planButtonPrice: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  planButtonAction: { fontSize: 14, fontWeight: '700', color: '#3b82f6' },
  downgradeText: { color: '#9ca3af' },
  confirmDowngradeBox: {
    backgroundColor: '#fef2f2', borderRadius: 8, padding: 12, marginTop: 4, marginBottom: 4,
  },
  confirmDowngradeText: { fontSize: 13, color: '#374151', marginBottom: 10 },
  confirmDowngradeActions: { flexDirection: 'row', gap: 8 },
  confirmDowngradeCancel: {
    flex: 1, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 6,
    padding: 8, alignItems: 'center',
  },
  confirmDowngradeCancelText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  confirmDowngradeConfirm: {
    flex: 1, backgroundColor: '#ef4444', borderRadius: 6, padding: 8, alignItems: 'center',
  },
  confirmDowngradeConfirmText: { fontSize: 13, color: '#fff', fontWeight: '700' },
  messageBanner: { borderRadius: 8, padding: 12, marginTop: 8, marginBottom: 4 },
  messageBannerSuccess: { backgroundColor: '#dcfce7' },
  messageBannerConflict: { backgroundColor: '#fef9c3' },
  messageBannerError: { backgroundColor: '#fee2e2' },
  messageBannerText: { fontSize: 13, color: '#111827', lineHeight: 18 },
  passwordMsg: { fontSize: 13, borderRadius: 6, padding: 8, marginBottom: 8 },
  passwordMsgOk: { backgroundColor: '#dcfce7', color: '#166534' },
  passwordMsgErr: { backgroundColor: '#fee2e2', color: '#991b1b' },
  changePasswordLink: { marginTop: 12 },
  changePasswordText: { fontSize: 14, color: '#3b82f6', fontWeight: '600' },
  changePasswordForm: { marginTop: 12 },
  passwordInput: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    padding: 10, fontSize: 14, color: '#111827', marginBottom: 8, backgroundColor: '#f9fafb',
  },
  passwordActions: { flexDirection: 'row', gap: 8 },
  cancelPasswordButton: {
    flex: 1, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    padding: 10, alignItems: 'center',
  },
  cancelPasswordText: { color: '#374151', fontWeight: '600' },
  savePasswordButton: {
    flex: 1, backgroundColor: '#3b82f6', borderRadius: 8, padding: 10, alignItems: 'center',
  },
  savePasswordText: { color: '#fff', fontWeight: '700' },
  signOutButton: {
    backgroundColor: '#fee2e2',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  signOutText: { color: '#ef4444', fontSize: 16, fontWeight: '700' },
});
