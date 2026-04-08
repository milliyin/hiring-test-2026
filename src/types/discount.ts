import { Platform } from 'react-native';

const firestoreModule = Platform.OS === 'web' ? require('firebase/firestore') : require('@react-native-firebase/firestore');
const Timestamp = Platform.OS === 'web' ? firestoreModule.Timestamp : firestoreModule.default.Timestamp;

import type { AddonType } from './subscription';

export type Discount = {
  id: string;
  code: string;
  percentOff: number; // 0-100
  appliesToBase: boolean; // applies to base plan price
  appliesToAddons: AddonType[] | 'all'; // which add-on types this discount applies to
  validUntil: Timestamp;
  usageLimit: number;
  usedCount: number;
};

// Whether a discount is currently valid for new applications
export function isDiscountValid(discount: Discount): boolean {
  const now = new Date();
  const expiry = discount.validUntil.toDate();
  return expiry > now && discount.usedCount < discount.usageLimit;
}

// Returns the price after applying the discount, or the original price if the discount
// does not apply to itemType. Expired / exhausted discounts return the original price.
// Decision on active subscribers with the discount already applied: honor until next renewal
// (i.e. do not retroactively strip). New applications are blocked by isDiscountValid().
export function calculateDiscountedPrice(
  basePrice: number,
  itemType: 'base' | AddonType,
  discount: Discount,
): number {
  if (!isDiscountValid(discount)) return basePrice;

  if (itemType === 'base') {
    if (!discount.appliesToBase) return basePrice;
  } else {
    const at = discount.appliesToAddons;
    if (at !== 'all' && !(Array.isArray(at) && at.includes(itemType))) return basePrice;
  }

  return Math.round(basePrice * (1 - discount.percentOff / 100) * 100) / 100;
}
