import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Discount } from '@/types/discount';
import { isDiscountValid } from '@/types/discount';

type Props = {
  discount: Discount;
};

export function DiscountTag({ discount }: Props) {
  const valid = isDiscountValid(discount);
  const expiry = discount.validUntil.toDate();
  const expiryStr = expiry.toLocaleDateString('en-CH', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <View style={[styles.tag, !valid && styles.tagExpired]}>
      <Text style={[styles.code, !valid && styles.expired]}>{discount.code}</Text>
      <Text style={[styles.detail, !valid && styles.expired]}>
        {discount.percentOff}% off
        {discount.appliesToBase && discount.appliesToAddons === 'all' && ' everything'}
        {discount.appliesToBase && discount.appliesToAddons !== 'all' && !Array.isArray(discount.appliesToAddons) && ' base plan'}
        {!discount.appliesToBase && ' add-ons only'}
      </Text>
      {!valid && <Text style={styles.expiredLabel}>Expired {expiryStr}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    backgroundColor: '#d1fae5',
    borderRadius: 6,
    padding: 8,
  },
  tagExpired: {
    backgroundColor: '#f3f4f6',
  },
  code: {
    fontSize: 13,
    fontWeight: '700',
    color: '#065f46',
    marginBottom: 2,
  },
  detail: {
    fontSize: 12,
    color: '#047857',
  },
  expired: {
    color: '#9ca3af',
  },
  expiredLabel: {
    fontSize: 11,
    color: '#ef4444',
    marginTop: 2,
  },
});
