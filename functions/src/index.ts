import * as admin from 'firebase-admin';

// Initialize Firebase Admin
admin.initializeApp();

// Export all Cloud Functions
export { handleStripeWebhook, expireGracePeriods } from './stripe/webhook';
export { createCheckoutSession, purchaseAddon, initiateDowngrade, removeStaffMember } from './stripe/checkout';
