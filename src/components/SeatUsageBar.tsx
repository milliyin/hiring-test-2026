import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

type Props = {
  used: number;
  max: number | typeof Infinity;
};

export function SeatUsageBar({ used, max }: Props) {
  const isUnlimited = max === Infinity;
  const percentage = isUnlimited ? 0 : max === 0 ? 0 : Math.min(used / max, 1);
  const isNearLimit = !isUnlimited && percentage >= 0.8;
  const isAtLimit = !isUnlimited && used >= max;

  const barColor = isAtLimit ? '#ef4444' : isNearLimit ? '#f59e0b' : '#3b82f6';

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>Staff seats</Text>
        <Text style={[styles.count, isAtLimit && styles.countAtLimit]}>
          {used} / {isUnlimited ? '∞' : max}
        </Text>
      </View>
      {!isUnlimited && (
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              { width: `${percentage * 100}%`, backgroundColor: barColor },
            ]}
          />
        </View>
      )}
      {isAtLimit && (
        <Text style={styles.warning}>Seat limit reached — upgrade plan or remove a staff member</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  label: { fontSize: 14, color: '#6b7280' },
  count: { fontSize: 14, fontWeight: '600', color: '#111827' },
  countAtLimit: { color: '#ef4444' },
  track: {
    height: 6,
    backgroundColor: '#e5e7eb',
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 3 },
  warning: { fontSize: 12, color: '#ef4444' },
});
