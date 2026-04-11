# blackcode SA — Clinic Billing App (2026 Hiring Test — Implemented)

A React Native / Expo clinic management app with a complete Stripe billing system, Firebase backend, and all 6 billing scenarios implemented. This fork contains the full implementation including Cloud Functions, Firestore security rules, integration tests, and a working owner signup flow.

---

## What's implemented

All 6 billing scenarios are complete and tested:

| # | Scenario | Status |
|---|---|---|
| 1 | Plan upgrade (Free → Pro → Premium) | Done |
| 2 | Downgrade with seat conflict detection | Done |
| 3 | Add-on purchase with discount validation | Done |
| 4 | Payment failure → 7-day grace period → revert to Free | Done |
| 5 | Expired discount code — rejected for new, honored for existing | Done |
| 6 | Staff removal with immediate session invalidation | Done |

See [DECISIONS.md](DECISIONS.md) for the architecture decisions behind each scenario.

---

## Stack

| Layer | Tech |
|---|---|
| Mobile | React Native + Expo (web + iOS + Android) |
| Backend | Firebase — Firestore, Auth, Cloud Functions v2 |
| Payments | Stripe (webhooks, subscriptions, coupons) |
| State | Zustand |
| Language | TypeScript strict |

---

## Prerequisites

Install these before starting:

- **Node 20** (functions runtime is Node 20; use `nvm` if needed)
- **Java 11+** (required by Firebase emulator)
- **Firebase CLI** — `npm install -g firebase-tools`
- **Stripe CLI** — [install guide](https://stripe.com/docs/stripe-cli)
- **Expo CLI** — `npm install -g expo-cli` (or use `npx expo`)

Verify:
```bash
firebase --version   # 13+
stripe --version     # 1.20+
node --version       # 20+
java -version        # 11+
```

---

## Setup

### 1. Clone and install

```bash
git clone <your-fork-url>
cd hiring-test-2026

npm install
cd functions && npm install && npm run build && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
cp functions/.env.example functions/.env
```

**`.env`** — Expo app (client-side):

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_FIREBASE_API_KEY` | Any string for emulator (e.g. `fake-api-key`) |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID` | `clinic-test-local` (must match `firebase.json`) |
| `EXPO_PUBLIC_USE_EMULATOR` | `true` for local dev |
| `EXPO_PUBLIC_EMULATOR_HOST` | `127.0.0.1` |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Your Stripe test key (`pk_test_...`) |

**`functions/.env`** — Cloud Functions:

| Variable | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | [Stripe dashboard → API keys](https://dashboard.stripe.com/test/apikeys) (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Output of `stripe listen` — see step 4 |
| `APP_URL` | `http://localhost:8081` for local dev |
| `STRIPE_PRICE_PRO` | Stripe product price ID for Pro plan |
| `STRIPE_PRICE_PREMIUM` | Stripe product price ID for Premium plan |
| `STRIPE_PRICE_VIP` | Stripe product price ID for VIP plan |
| `STRIPE_PRICE_EXTRA_STORAGE` | Stripe product price ID for Extra Storage add-on |
| `STRIPE_PRICE_EXTRA_SEATS` | Stripe product price ID for Extra Seats add-on |
| `STRIPE_PRICE_ADVANCED_ANALYTICS` | Stripe product price ID for Advanced Analytics add-on |

### 3. Create Stripe products (one-time)

In the [Stripe test dashboard](https://dashboard.stripe.com/test/products), create recurring monthly products in CHF:

| Product | Suggested price |
|---|---|
| Pro | CHF 49/month |
| Premium | CHF 99/month |
| VIP | CHF 199/month |
| Extra Storage | CHF 9/month |
| Extra Seats | CHF 19/month |
| Advanced Analytics | CHF 29/month |

Copy each price ID (`price_...`) into `functions/.env`.

---

## Running locally

You need **4 terminals**.

### Terminal 1 — Firebase emulator

```bash
npm run emulator
```

Starts Firestore (`:8080`), Auth (`:9099`), Functions (`:5001`), and the emulator UI (`:4000`).
Data is persisted to `./emulator-data` between restarts.

### Terminal 2 — Seed the emulator

Run once after the emulator is up (and again after a `clearEmulatorData` test run):

```bash
npm run seed
```

Creates test users, a clinic, subscription, and appointments.

**To reset and reseed** (e.g. after running tests or corrupting state):

```bash
curl -X DELETE "http://localhost:8080/emulator/v1/projects/clinic-test-local/databases/(default)/documents"
curl -X DELETE "http://localhost:9099/emulator/v1/projects/clinic-test-local/accounts"
npm run seed
```

**Test accounts** (all passwords: `test1234`):
- Owner: `sophie.owner@test.com`
- Staff: `anna.staff@test.com` / `marc.staff@test.com`
- Patients: `patient1@test.com` / `patient2@test.com`

> **Important:** The seed creates the clinic with a `free` plan and placeholder Stripe IDs. To test billing features (add-ons, downgrade, grace period), you must complete a real Stripe Checkout first:
> 1. Log in as the owner (`sophie.owner@test.com`)
> 2. Go to **Billing** and upgrade to any paid plan
> 3. Complete the Stripe Checkout (use test card `4242 4242 4242 4242`)
> 4. The webhook will update Firestore with a real `stripeCustomerId` and `stripeSubscriptionId`
> 5. Add-on purchases and downgrade flows will work after this step

### Terminal 3 — Stripe webhook listener

```bash
stripe listen --forward-to http://127.0.0.1:5001/clinic-test-local/us-central1/handleStripeWebhook
```

Copy the `whsec_...` secret it prints and paste it into `functions/.env` as `STRIPE_WEBHOOK_SECRET`.
Restart the emulator after updating `.env`.

### Terminal 4 — Expo app

```bash
npm start
```

Then press:
- `w` — open in browser (recommended for quick testing)
- `a` — Android emulator
- `i` — iOS simulator

---

## Running tests

Integration tests run against a live Firestore emulator. Start the emulator first, then:

```bash
cd functions
npm test
```

**Warning:** `beforeEach` wipes all Firestore data in the emulator. Run tests before manual testing or reseed afterward with `npm run seed` from the root.

Expected output: **21 tests passing** across `webhook.test.ts` and `checkout.test.ts`.

---

## Project structure

```
hiring-test-2026/
├── app/
│   ├── (auth)/          # Login, signup screens
│   └── (app)/           # Main app: appointments, billing, staff
├── src/
│   ├── components/      # Reusable UI (SeatUsageBar, DiscountTag, etc.)
│   ├── hooks/           # useAuth, useClinic, useSubscription
│   ├── services/        # auth.ts, firestore.ts, stripe.ts, firebase.ts
│   ├── store/           # Zustand stores
│   └── types/           # TypeScript types + discount logic
├── functions/
│   └── src/stripe/      # Cloud Functions: checkout.ts, webhook.ts + tests
├── scripts/
│   └── seed.ts          # Emulator seed script
├── firestore.rules      # Security rules
├── DECISIONS.md         # Architecture decision records
└── firebase.json        # Emulator config
```

---

## Emulator UI

Open [http://localhost:4000](http://localhost:4000) after starting the emulator to browse Firestore, Auth users, and function logs.

Key collections:
- `users/{uid}` — role, clinicId
- `clinics/{clinicId}` — seats.used, seats.max, plan
- `subscriptions/{clinicId}` — status (active / grace_period / cancelled), plan
- `seats/{clinicId}/members/{uid}` — active flag
- `discounts/{discountId}` — validUntil, usedCount, maxUses, appliesToBase, appliesToAddons

---

## Deploying to production

### Firebase

```bash
# Authenticate
firebase login

# Set your real project ID in .firebaserc
firebase use <your-project-id>

# Deploy rules + functions
firebase deploy --only firestore:rules,functions
```

### Environment variables for deployed functions

```bash
# Set each secret via Firebase CLI (not .env — that's for emulator only)
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

Or use `firebase functions:config:set` for non-secret config.

Update `functions/src/stripe/checkout.ts` and `webhook.ts` to read from `defineSecret()` instead of `process.env` for production.

---

## Known limitations / TODOs

- **Staff invite flow** — `handleInviteStaff` in `staff.tsx` shows a TODO alert. The server-side seat check is enforced via Firestore rules; the invite UI is not implemented.
- **Stripe Customer Portal** — not wired up; billing management is manual via the billing screen.
- **`currentPeriodEnd` sync** — currently set to 30 days from signup; should be updated from real Stripe invoice data in `handleCheckoutCompleted`.
- **Webhook idempotency** — `checkout.session.completed` does not deduplicate retries.
- **Plan-gated features** — analytics and file attachments are not yet locked behind add-on checks in Firestore rules (the TODO comments are in `firestore.rules`).
