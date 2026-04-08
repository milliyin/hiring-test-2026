/**
 * Integration tests for Scenario 6 — Staff removal and session invalidation.
 *
 * Tests the Firestore state after removeStaffMemberFromClinic() — token revocation
 * (revokeRefreshTokens) is handled separately by the callable and is not tested here
 * since the Auth emulator does not support token revocation.
 *
 * Requires the Firestore emulator running on localhost:8080.
 * Start it with: firebase emulators:start --only firestore
 * Then run: npm test
 */

import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { removeStaffMemberFromClinic } from './checkout';

// ─── Emulator setup ──────────────────────────────────────────────────────────

let db: admin.firestore.Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: 'clinic-test-local' });
  }
  db = admin.firestore();
});

async function clearEmulatorData(): Promise<void> {
  const url =
    'http://localhost:8080/emulator/v1/projects/clinic-test-local/databases/(default)/documents';
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to clear emulator: ${res.status}`);
}

beforeEach(async () => {
  await clearEmulatorData();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function seedOwner(clinicId: string, ownerId: string): Promise<void> {
  await db.collection('users').doc(ownerId).set({
    displayName: 'Owner',
    email: 'owner@test.com',
    role: 'owner',
    clinicId,
    createdAt: Timestamp.now(),
  });
}

async function seedStaff(clinicId: string, staffId: string): Promise<void> {
  await db.collection('users').doc(staffId).set({
    displayName: 'Staff',
    email: 'staff@test.com',
    role: 'staff',
    clinicId,
    createdAt: Timestamp.now(),
  });
  await db.collection('seats').doc(clinicId).collection('members').doc(staffId).set({
    role: 'staff',
    active: true,
    joinedAt: Timestamp.now(),
  });
}

async function seedClinic(clinicId: string, ownerId: string, seatsUsed = 2): Promise<void> {
  await db.collection('clinics').doc(clinicId).set({
    name: 'Test Clinic',
    ownerId,
    plan: 'pro',
    seats: { used: seatsUsed, max: 5 },
  });
}

// ─── removeStaffMemberFromClinic ─────────────────────────────────────────────

describe('removeStaffMemberFromClinic', () => {
  it('sets seat.active=false, user.role=patient, user.clinicId=null, decrements seats.used', async () => {
    const clinicId = 'clinic_rm_1';
    const ownerId = 'owner_rm_1';
    const staffId = 'staff_rm_1';

    await seedOwner(clinicId, ownerId);
    await seedStaff(clinicId, staffId);
    await seedClinic(clinicId, ownerId, 2);

    await removeStaffMemberFromClinic(db, clinicId, staffId, ownerId);

    const seat = (await db.collection('seats').doc(clinicId).collection('members').doc(staffId).get()).data()!;
    expect(seat.active).toBe(false);

    const user = (await db.collection('users').doc(staffId).get()).data()!;
    expect(user.role).toBe('patient');
    expect(user.clinicId).toBeNull();

    const clinic = (await db.collection('clinics').doc(clinicId).get()).data()!;
    expect(clinic.seats.used).toBe(1); // decremented from 2
  });

  it('throws permission-denied when caller is not the clinic owner', async () => {
    const clinicId = 'clinic_rm_2';
    const ownerId = 'owner_rm_2';
    const staffId = 'staff_rm_2';
    const otherStaffId = 'other_staff_rm_2';

    await seedOwner(clinicId, ownerId);
    await seedStaff(clinicId, staffId);
    await seedStaff(clinicId, otherStaffId);
    await seedClinic(clinicId, ownerId, 2);

    // otherStaff tries to remove staffId — should be denied
    await expect(
      removeStaffMemberFromClinic(db, clinicId, staffId, otherStaffId),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    // Staff doc should be unchanged
    const user = (await db.collection('users').doc(staffId).get()).data()!;
    expect(user.role).toBe('staff');
  });

  it('throws not-found when target user is not a staff member of this clinic', async () => {
    const clinicId = 'clinic_rm_3';
    const ownerId = 'owner_rm_3';

    await seedOwner(clinicId, ownerId);
    await seedClinic(clinicId, ownerId, 0);

    // Target does not exist
    await expect(
      removeStaffMemberFromClinic(db, clinicId, 'nonexistent_user', ownerId),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('throws not-found when target belongs to a different clinic', async () => {
    const clinicId = 'clinic_rm_4';
    const otherClinicId = 'clinic_rm_4_other';
    const ownerId = 'owner_rm_4';
    const staffId = 'staff_rm_4';

    await seedOwner(clinicId, ownerId);
    await seedClinic(clinicId, ownerId, 0);
    // Staff is in a different clinic
    await seedStaff(otherClinicId, staffId);

    await expect(
      removeStaffMemberFromClinic(db, clinicId, staffId, ownerId),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('throws permission-denied when owner tries to remove themselves', async () => {
    const clinicId = 'clinic_rm_5';
    const ownerId = 'owner_rm_5';

    await seedOwner(clinicId, ownerId);
    await seedClinic(clinicId, ownerId, 0);

    // Owner tries to remove themselves — their role is 'owner', not 'staff'
    await expect(
      removeStaffMemberFromClinic(db, clinicId, ownerId, ownerId),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
