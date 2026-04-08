import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/hooks/useAuth';
import { useClinic } from '@/hooks/useClinic';
import { useSubscription } from '@/hooks/useSubscription';
import { getClinicAddons, getClinicDiscounts } from '@/services/firestore';
import { purchaseAddon } from '@/services/stripe';
import { PlanBadge } from '@/components/PlanBadge';
import { SeatUsageBar } from '@/components/SeatUsageBar';
import { DiscountTag } from '@/components/DiscountTag';
import { ADDON_CONFIG } from '@/types/subscription';
import type { Addon } from '@/types/subscription';
import type { Discount } from '@/types/discount';

export default function BillingScreen() {
  const { isOwner } = useAuth();
  const { clinic } = useClinic();
  const { plan, status, config, seatsUsed, seatsMax } = useSubscription();
  const [addons, setAddons] = useState<Addon[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [pendingAddon, setPendingAddon] = useState<string | null>(null);
  const [discountCode, setDiscountCode] = useState('');
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [addonMessage, setAddonMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (!clinic) return;
    getClinicAddons(clinic.id).then(setAddons);
    getClinicDiscounts(clinic.id).then(setDiscounts);
  }, [clinic?.id]);

  if (!isOwner) {
    return (
      <View style={styles.restricted}>
        <Text style={styles.restrictedText}>Billing is only visible to clinic owners.</Text>
      </View>
    );
  }

  function handleUpgrade() {
    router.push('/(app)/settings');
  }

  function handlePurchaseAddon(addonType: string) {
    setPendingAddon(addonType);
    setDiscountCode('');
    setAddonMessage(null);
  }

  async function confirmPurchase() {
    if (!clinic || !pendingAddon || isPurchasing) return;
    setIsPurchasing(true);
    setAddonMessage(null);
    try {
      await purchaseAddon({
        clinicId: clinic.id,
        addonType: pendingAddon as 'extra_storage' | 'extra_seats' | 'advanced_analytics',
        discountCode: discountCode.trim() || undefined,
      });
      setAddonMessage({ type: 'success', text: `Add-on purchased successfully.` });
      setPendingAddon(null);
      setDiscountCode('');
      // Refresh add-on list
      getClinicAddons(clinic.id).then(setAddons);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Could not purchase add-on.';
      console.error('[confirmPurchase]', err);
      setAddonMessage({ type: 'error', text: msg });
    } finally {
      setIsPurchasing(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Current plan */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Current plan</Text>
        <View style={styles.planRow}>
          <PlanBadge plan={plan} />
          <Text style={styles.planPrice}>
            {config.price === 0 ? 'Free' : `CHF ${config.price}/mo`}
          </Text>
        </View>
        <Text style={styles.planStatus}>
          Status: <Text style={status === 'active' ? styles.active : styles.inactive}>{status}</Text>
        </Text>
        {status === 'grace_period' && (
          <View style={styles.warningBanner}>
            <Text style={styles.warningText}>
              Payment failed. You have a grace period to resolve this.
              New staff cannot be added until billing is resolved.
            </Text>
            {/* TODO [CHALLENGE]: Show gracePeriodEnd date from subscription */}
            {/* TODO [CHALLENGE]: After grace period ends, plan reverts to Free (Scenario 4) */}
          </View>
        )}
      </View>

      {/* Seat usage */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Seats</Text>
        <SeatUsageBar used={seatsUsed} max={seatsMax} />
      </View>

      {/* Active add-ons */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active add-ons</Text>
        {addons.length === 0 ? (
          <Text style={styles.empty}>No active add-ons.</Text>
        ) : (
          addons.map((addon) => (
            <View key={addon.id} style={styles.addonRow}>
              <View>
                <Text style={styles.addonName}>{ADDON_CONFIG[addon.type].label}</Text>
                <Text style={styles.addonDesc}>{ADDON_CONFIG[addon.type].description}</Text>
              </View>
              <Text style={styles.addonPrice}>CHF {addon.price}/mo</Text>
            </View>
          ))
        )}

        {/* Available add-ons to purchase */}
        <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Available add-ons</Text>
        {Object.entries(ADDON_CONFIG).map(([type, meta]) => {
          const alreadyActive = addons.some((a) => a.type === type);
          if (alreadyActive) return null;
          if (plan === 'free') return null; // Add-ons require a paid plan
          return (
            <TouchableOpacity
              key={type}
              style={styles.addonCard}
              onPress={() => handlePurchaseAddon(type)}
            >
              <View>
                <Text style={styles.addonName}>{meta.label}</Text>
                <Text style={styles.addonDesc}>{meta.description}</Text>
              </View>
              <View style={styles.addonCardRight}>
                <Text style={styles.addonPrice}>CHF {meta.price}/mo</Text>
                <Text style={styles.addButton}>Add</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        {plan === 'free' && (
          <Text style={styles.empty}>Upgrade to a paid plan to add add-ons.</Text>
        )}

        {/* Inline purchase panel — shown when user taps "Add" on an add-on */}
        {pendingAddon && (
          <View style={styles.purchasePanel}>
            <Text style={styles.purchasePanelTitle}>
              Purchase {ADDON_CONFIG[pendingAddon as keyof typeof ADDON_CONFIG]?.label}
            </Text>
            <TextInput
              style={styles.discountInput}
              placeholder="Discount code (optional)"
              value={discountCode}
              onChangeText={setDiscountCode}
              autoCapitalize="characters"
              editable={!isPurchasing}
            />
            <View style={styles.purchasePanelButtons}>
              <TouchableOpacity
                style={[styles.confirmButton, isPurchasing && { opacity: 0.5 }]}
                onPress={confirmPurchase}
                disabled={isPurchasing}
              >
                <Text style={styles.confirmButtonText}>
                  {isPurchasing ? 'Processing...' : 'Confirm purchase'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => { setPendingAddon(null); setAddonMessage(null); }}
                disabled={isPurchasing}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {addonMessage && (
          <View style={[
            styles.addonMessageBanner,
            addonMessage.type === 'success' ? styles.addonMessageSuccess : styles.addonMessageError,
          ]}>
            <Text style={styles.addonMessageText}>{addonMessage.text}</Text>
          </View>
        )}
      </View>

      {/* Active discounts */}
      {discounts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active discounts</Text>
          {discounts.map((d) => (
            <DiscountTag key={d.id} discount={d} />
          ))}
          {/* TODO [CHALLENGE]: Scenario 5 — show expired discount state clearly */}
        </View>
      )}

      {/* Upgrade CTA */}
      {plan !== 'vip' && (
        <TouchableOpacity style={styles.upgradeButton} onPress={handleUpgrade}>
          <Text style={styles.upgradeText}>Upgrade plan</Text>
        </TouchableOpacity>
      )}
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
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  planRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planPrice: { fontSize: 20, fontWeight: '700', color: '#111827' },
  planStatus: { fontSize: 14, color: '#6b7280' },
  active: { color: '#059669', fontWeight: '600' },
  inactive: { color: '#ef4444', fontWeight: '600' },
  warningBanner: {
    backgroundColor: '#fef3c7',
    borderRadius: 6,
    padding: 12,
  },
  warningText: { fontSize: 13, color: '#92400e' },
  addonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  addonCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    marginBottom: 8,
  },
  addonCardRight: { alignItems: 'flex-end' },
  addonName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  addonDesc: { fontSize: 12, color: '#6b7280', maxWidth: 200 },
  addonPrice: { fontSize: 14, fontWeight: '700', color: '#111827' },
  addButton: { fontSize: 13, color: '#3b82f6', fontWeight: '600' },
  empty: { fontSize: 14, color: '#9ca3af' },
  purchasePanel: { marginTop: 12, padding: 12, borderWidth: 1, borderColor: '#d1fae5', borderRadius: 8, backgroundColor: '#f0fdf4' },
  purchasePanelTitle: { fontSize: 14, fontWeight: '700', color: '#111827', marginBottom: 8 },
  discountInput: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 6, padding: 8, fontSize: 14, backgroundColor: '#fff', marginBottom: 8 },
  purchasePanelButtons: { flexDirection: 'row', gap: 8 },
  confirmButton: { flex: 1, backgroundColor: '#3b82f6', borderRadius: 6, padding: 10, alignItems: 'center' },
  confirmButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  cancelButton: { flex: 1, backgroundColor: '#e5e7eb', borderRadius: 6, padding: 10, alignItems: 'center' },
  cancelButtonText: { color: '#374151', fontWeight: '600', fontSize: 13 },
  addonMessageBanner: { marginTop: 8, padding: 10, borderRadius: 6 },
  addonMessageSuccess: { backgroundColor: '#dcfce7' },
  addonMessageError: { backgroundColor: '#fee2e2' },
  addonMessageText: { fontSize: 13, color: '#111827', lineHeight: 18 },
  upgradeButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  upgradeText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  restricted: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  restrictedText: { fontSize: 16, color: '#6b7280', textAlign: 'center' },
});
