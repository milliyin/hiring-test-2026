# Architecture decisions

## Scenario 1 — Plan upgrade: webhook-first, not optimistic

**Choice: Firestore reflects the new plan only after `checkout.session.completed` fires.**

The client calls `createCheckoutSession`, which redirects to Stripe Checkout. Firestore is NOT updated at session creation — it is updated only in `handleCheckoutCompleted` after Stripe confirms the payment.

**Why:**
- A session can be abandoned, the payment can fail, or the card can be declined. Updating Firestore at session creation would show a plan upgrade that was never paid for.
- Stripe guarantees `checkout.session.completed` fires exactly once on confirmed payment. This is the correct moment to change state.
- Proration is handled entirely by Stripe (subscription item price change). We don't attempt to calculate it ourselves.

**Seat limit update:** `clinic.seats.max` is updated in the same webhook handler to the new plan's limit, atomically with the plan field. This means the UI shows the correct seat capacity immediately after the webhook processes — no polling needed, since the Zustand store subscribes to the Firestore `clinics` doc in real-time.

---

## Scenario 3 — Add-on purchase: server-side discount enforcement

**Choice: All discount validation runs in the Cloud Function, not the client.**

The client sends the discount code; the `purchaseAddon` function re-validates it before any Stripe API call. The client-side `calculateDiscountedPrice` (in `src/types/discount.ts`) is used only for UI display.

**Why server-side:**
- The client is untrusted. If discount validation ran only in the UI, any user could intercept the function call and inject an arbitrary coupon.
- `purchaseAddon` checks: code exists in Firestore, not expired (`validUntil`), not exhausted (`usedCount < maxUses`), and `appliesToAddons === true`. Any failure throws `failed-precondition` before touching Stripe.
- The Stripe coupon is created on-the-fly (not stored in Stripe ahead of time) because discount codes are stored in Firestore and only become Stripe objects when applied. This avoids maintaining a parallel coupon catalog in Stripe.

**Duplicate add-on check:** If the clinic already has the add-on in `addons/{clinicId}/items/{addonId}`, the function throws `already-exists` rather than creating a duplicate Stripe subscription item. This is enforced server-side, not by Firestore rules alone.

---

## Scenario 2 — Downgrade with seat conflict: Block vs Queue

**Choice: Block (Option A)**

When the owner tries to downgrade and their active staff count exceeds the target plan's seat limit, the `initiateDowngrade` Cloud Function throws a `failed-precondition` error and does not touch Stripe at all. The UI surfaces the error with a count of how many staff need to be removed.

**Why block instead of queue:**

- **No complex state to manage.** A queued downgrade requires a `pendingDowngrade` field in Firestore, a Firestore rule that blocks new staff from joining during the pending window, a cron job or Stripe `subscription_schedule` to execute at cycle end, and a cancellation flow if the owner changes their mind. That's four moving parts that all need to stay in sync.
- **Owner has full control.** They choose exactly which staff to remove (via Scenario 6 — `removeStaffMember`). There's no surprise cut-off at the end of a billing cycle.
- **No data inconsistency risk.** Queuing means two systems (Stripe and Firestore) must agree on when to switch — if the webhook fires late or is dropped, Firestore and Stripe diverge.
- **Tradeoff acknowledged:** blocking forces the owner to act before downgrading, which is a slightly worse UX than queuing. Acceptable because: (a) the error message is explicit about what to do, (b) this is an infrequent operation, (c) the alternative complexity is not worth it for a clinic SaaS at this scale.

**How it works end-to-end:**

1. Owner taps "Downgrade to Pro" in Settings.
2. `initiateDowngrade` Cloud Function counts `seats/{clinicId}/members` where `active == true` and `role == staff`.
3. If count ≤ target plan's seat limit → update Stripe subscription item price (or cancel for free). Webhook (`customer.subscription.updated` / `customer.subscription.deleted`) syncs Firestore.
4. If count > limit → throw `failed-precondition` with `conflictingSeats` count. Client shows alert directing owner to the Staff screen.

**Firestore rules enforcement:**

`seats/{clinicId}/members` write rule now requires:
- Caller is owner
- For activating a new seat: `subscription.status` is `active` AND `clinic.seats.used < clinic.seats.max`
- Deactivating a seat is always allowed (needed for staff removal and cancellation cleanup)

---

## Scenario 4 — Grace period duration: 7 days

**Choice: 7 days**

Matches Stripe's Smart Retry window. By the time our grace period expires, Stripe has exhausted all payment retries and will send `customer.subscription.deleted`, which our webhook already handles (revert to Free, deactivate staff seats). The `expireGracePeriods` scheduled function (hourly) acts as a safety net in case the Stripe webhook is delayed or missed.

**Enforcement:** Firestore `clinicIsFullyActive()` helper (status == 'active' only) blocks new seat activations during grace period. Existing features (appointments, add-ons, staff access) remain available throughout the grace window.

---

## Scenario 5 — Expired discount codes: honor until renewal

**Choice: Honor active Stripe coupons until the subscription naturally renews.**

When a discount code was valid at time of purchase, a Stripe coupon with `duration: 'forever'` is attached to the subscription item. If the Firestore discount record later expires (`validUntil` passes), we do NOT proactively strip the Stripe coupon.

**Why:**
- The customer made a purchasing decision based on the discount being applied. Retroactively removing it mid-cycle is a broken UX and could trigger disputes.
- Stripe's `duration: 'forever'` means the coupon continues on each renewal invoice — this is intentional. The customer locked in the deal at a moment when the code was valid.
- Proactive stripping would require tracking which Stripe subscription items have which coupons, calling `stripe.subscriptionItems.update` to remove the discount, and handling partial billing cycles. That complexity is not justified at this scale.
- Most SaaS platforms (Notion, Linear, etc.) follow the same convention: lock in the rate, don't retroactively raise prices.

**New applications:** Rejected at the function boundary via `isDiscountValid()` in both `createCheckoutSession` and `purchaseAddon`. Expired or exhausted codes throw `failed-precondition` before any Stripe API call is made.

**usedCount timing:** Incremented in `checkout.session.completed` webhook (after confirmed payment), NOT at session creation. This prevents abandoned checkouts from consuming discount uses.

**UI:** `DiscountTag` component renders expired discounts in grey with a red "Expired {date}" label, making the expiry state visible to the owner in the Billing screen.

---

## Scenario 6 — Session invalidation on staff removal: Combined A + B

**Choice: Option A (revokeRefreshTokens) + Option B (Firestore role-based rules), combined.**

**Why not B alone:**
Firestore rules already call `getUserRole()` which reads `users/{uid}.data.role` in real-time. As soon as the transaction sets `users.role = 'patient'` and `users.clinicId = null`, every subsequent Firestore request from the removed user is denied — no additional rule changes needed. However, token revocation is still needed to prevent the user from calling other Firebase services or refreshing their token after the 1-hour window.

**Why not A alone:**
`revokeRefreshTokens` prevents new tokens from being issued, but the existing ID token remains valid for up to 1 hour. During that window, if we relied only on token revocation, the removed staff member could still access Firestore (their cached token would pass auth checks). The Firestore rule check closes this gap.

**Why not C (custom claims):**
Custom claims are embedded in the ID token. Updating them requires the client to call `getIdToken(true)` to force a refresh — you cannot guarantee a revoked client will cooperate. Claims-based blocking has the same 1-hour window as Option A with no benefit over the role-in-Firestore approach.

**How it works:**
1. `removeStaffMember` Cloud Function atomically updates Firestore in a single transaction:
   - `seats/{clinicId}/members/{uid}.active = false` — deactivates the seat record
   - `users/{uid}.role = 'patient'`, `users/{uid}.clinicId = null` — **this is the critical step** that triggers immediate Firestore rule blocking for all subsequent requests
   - `clinics/{clinicId}.seats.used -= 1` — keeps seat counter accurate
2. `admin.auth().revokeRefreshTokens(uid)` is called after the transaction (best-effort; if it fails, Firestore is still protected).
3. UI shows a confirmation dialog before removal and a loading spinner during the async call. The member list refreshes automatically on success.

**Additional enforcement — appointments rule:**
`isSeatActive(clinicId, userId)` is checked in the appointments read/write rules. This means a removed staff member cannot access appointments even during the 1-hour window before their ID token expires — the seat deactivation takes effect immediately at the rule level, independent of role change and token revocation.

---

## Owner signup: sequential Firestore writes, not a batch

**Choice: `signUp()` writes documents sequentially — users → clinic → subscription → seat — not in a single batch.**

**Why:**
Firestore security rules evaluate in real-time against the current database state at the moment of each write. A batch write commits all documents atomically, but the rules for each document in the batch cannot see documents written by the *same* batch. This means:

- The `clinic` write rule calls `getUserRole()` which reads `users/{uid}`. If users and clinic are in the same batch, the rule sees no users doc yet → denied.
- The `seat` write rule calls `clinicIsFullyActive()` which reads `subscriptions/{clinicId}`. Same problem.

Sequential writes avoid this: by the time we write the clinic, the users doc already exists. By the time we write the seat, the subscription already exists. Each rule check passes because the preceding document is committed.

**Trade-off:** Sequential writes are slower (~4 round trips vs 1). Acceptable at signup — this is a one-time, user-initiated flow where a 500ms delay is unnoticeable.

---

## Staff invite: server-side user creation with temporary password

**Choice: `inviteStaff` Cloud Function creates the Auth user and Firestore records. The owner receives a temporary password to share with the new staff member out-of-band.**

**Why not email invite links:**
- Firebase Dynamic Links are deprecated. Rolling a custom invite-link flow requires hosting a landing page, generating signed tokens, and handling link expiry — significant overhead for a hiring test scope.
- Email delivery in emulator dev is unreliable without a third-party provider (SendGrid, etc.).

**Why not a shareable clinic code:**
- A clinic code requires the new user to self-register and then "join" — two flows instead of one. Ownership of the email address is unverified.

**How it works:**
1. Owner fills name + email in the inline invite form (no Modal — avoids Expo web re-render issues).
2. Client calls `inviteStaff` Cloud Function.
3. Function verifies: caller is owner of clinicId, subscription is `active` (not grace period), `seats.used < seats.max`.
4. Creates Firebase Auth user (or resets password if email already exists via `getUserByEmail`).
5. In a Firestore transaction: writes `users/{uid}` with `role: 'staff'`, `clinicId`; writes `seats/{clinicId}/members/{uid}` with `active: true`; increments `clinic.seats.used`.
6. Returns `{ tempPassword }` to the client.
7. UI shows credentials inline for the owner to copy and share. Hint displayed: "They should change their password after first login."

**Security:** Seat availability is enforced server-side in the function before any write. The Firestore `clinicIsFullyActive()` rule on seat writes is a second enforcement layer. Temp password is 12 characters (alphanumeric), generated with `crypto.randomBytes`.

---

## Platform abstraction: runtime require() over conditional imports

**Choice: `src/services/auth.ts` and `src/services/firestore.ts` use `Platform.OS === 'web' ? require('firebase/auth') : require('@react-native-firebase/auth')` at runtime.**

This project targets both Expo Web and React Native (iOS/Android). The two platforms need different Firebase SDKs:
- Web: modular `firebase/auth`, `firebase/firestore` (v10 compat)
- Native: `@react-native-firebase/auth`, `@react-native-firebase/firestore` (native module bridge)

**Why runtime require() instead of separate entry points:**
- Expo Router's file-based routing makes platform-specific files (`.web.ts` / `.native.ts`) awkward for service files that are imported by shared screens.
- A single service file with internal branching keeps the import graph simple — screens don't need to know which platform they're on.
- The `require()` calls are cached by Metro/webpack after the first call; there's no repeated evaluation.

**Trade-off:** TypeScript loses some type inference on the required modules (typed as `any` in some places). Mitigated by wrapping platform differences in typed helper functions (`fsSet`, `now`, `futureTimestamp`) so call sites are fully typed.

---

## Test strategy: integration tests against real emulator, not mocks

**Choice: `webhook.test.ts` and `checkout.test.ts` run against the live Firestore emulator via the Admin SDK. No Firestore mocking.**

**Why:**
- Mocked Firestore (e.g. `jest-mock-firestore`) validates that you called the right methods, not that the data is correct. Our prior experience: mocked tests passed while a real Firestore migration failed because the mock didn't enforce field types.
- The emulator is already running for manual development. Reusing it for tests means the test environment matches production behavior exactly — including security rules, transaction semantics, and index behavior.
- `beforeEach` calls the emulator REST API to clear all data, so each test starts with a known state.

**Trade-off:** Tests require the emulator to be running (`firebase emulators:start`). They also wipe emulator data in `beforeEach`, so running tests during a manual session destroys your seed data. Solution: run `npm run seed` from the root after a test run to restore test accounts.
