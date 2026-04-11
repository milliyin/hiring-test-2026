// Stripe service — client-side helpers and typed stubs.
// Actual Stripe operations happen in Cloud Functions (functions/src/stripe/).
// The client calls Firebase Functions, which call Stripe server-side.
// This keeps the Stripe secret key off the device.

import { Platform } from 'react-native';
import { firebaseApp } from './firebase';

const functionsModule = Platform.OS === 'web' ? require('firebase/functions') : require('@react-native-firebase/functions');
const functions = Platform.OS === 'web' ? functionsModule.getFunctions(firebaseApp) : functionsModule.default;

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === 'true';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? 'localhost';

if (USE_EMULATOR) {
  if (Platform.OS === 'web') {
    functionsModule.connectFunctionsEmulator(functions, EMULATOR_HOST, 5001);
  } else {
    functions().useEmulator(EMULATOR_HOST, 5001);
  }
}

export type CreateCheckoutParams = {
  clinicId: string;
  plan: 'pro' | 'premium' | 'vip';
  discountCode?: string;
};

export type CheckoutResult = {
  sessionId: string;
  url: string;
};

export async function createCheckoutSession(
  params: CreateCheckoutParams,
): Promise<CheckoutResult> {
  if (Platform.OS === 'web') {
    const { httpsCallable } = functionsModule;
    const fn = httpsCallable(functions, 'createCheckoutSession');
    const result = await fn(params);
    return result.data as CheckoutResult;
  } else {
    const result = await functions().httpsCallable('createCheckoutSession')(params);
    return result.data as CheckoutResult;
  }
}

export type AddonPurchaseParams = {
  clinicId: string;
  addonType: 'extra_storage' | 'extra_seats' | 'advanced_analytics';
  discountCode?: string;
};

export async function purchaseAddon(
  params: AddonPurchaseParams,
): Promise<void> {
  if (Platform.OS === 'web') {
    const { httpsCallable } = functionsModule;
    const fn = httpsCallable(functions, 'purchaseAddon');
    await fn(params);
  } else {
    await functions().httpsCallable('purchaseAddon')(params);
  }
}

export type DowngradeParams = {
  clinicId: string;
  targetPlan: 'free' | 'pro' | 'premium';
};

export type DowngradeResult = {
  // 'immediate': downgrade processed now (no seat conflict, or user resolved conflict)
  // 'queued': scheduled for end of billing period (seat conflict detected)
  strategy: 'immediate' | 'queued';
  conflictingSeats?: number; // how many seats exceed target plan limit
  effectiveDate?: string; // ISO date if queued
};

export async function initiateDowngrade(
  params: DowngradeParams,
): Promise<DowngradeResult> {
  if (Platform.OS === 'web') {
    const { httpsCallable } = functionsModule;
    const fn = httpsCallable(functions, 'initiateDowngrade');
    const result = await fn(params);
    return result.data as DowngradeResult;
  } else {
    const result = await functions().httpsCallable('initiateDowngrade')(params);
    return result.data as DowngradeResult;
  }
}

export async function removeStaffMember(clinicId: string, targetUserId: string): Promise<void> {
  if (Platform.OS === 'web') {
    const { httpsCallable } = functionsModule;
    const fn = httpsCallable(functions, 'removeStaffMember');
    await fn({ clinicId, targetUserId });
  } else {
    await functions().httpsCallable('removeStaffMember')({ clinicId, targetUserId });
  }
}

export async function removeAddon(clinicId: string, addonId: string): Promise<void> {
  if (Platform.OS === 'web') {
    const { httpsCallable } = functionsModule;
    const fn = httpsCallable(functions, 'removeAddon');
    await fn({ clinicId, addonId });
  } else {
    await functions().httpsCallable('removeAddon')({ clinicId, addonId });
  }
}

export async function inviteStaff(params: {
  clinicId: string;
  email: string;
  displayName: string;
}): Promise<{ tempPassword: string }> {
  if (Platform.OS === 'web') {
    const { httpsCallable } = functionsModule;
    const fn = httpsCallable(functions, 'inviteStaff');
    const result = await fn(params);
    return result.data as { tempPassword: string };
  } else {
    const result = await functions().httpsCallable('inviteStaff')(params);
    return result.data as { tempPassword: string };
  }
}
