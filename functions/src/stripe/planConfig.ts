// Server-side plan config — keep in sync with src/types/subscription.ts
// Duplicated here to avoid importing client-side code into Cloud Functions.
export const PLAN_CONFIG_SERVER = {
  free:    { price: 0,   seats: 1,         label: 'Free' },
  pro:     { price: 99,  seats: 5,         label: 'Pro' },
  premium: { price: 249, seats: 15,        label: 'Premium' },
  vip:     { price: 499, seats: Infinity,  label: 'VIP' },
} as const;

export const ADDON_SEATS_BONUS = 5; // Extra Seats Pack adds 5 seats per purchase

export const ADDON_CONFIG_SERVER = {
  extra_storage:      { price: 19 },
  extra_seats:        { price: 49 },
  advanced_analytics: { price: 79 },
} as const;
