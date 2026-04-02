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
