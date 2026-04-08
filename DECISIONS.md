# Architecture decisions

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
