import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

/**
 * Invites a staff member to the clinic.
 *
 * Server enforces: owner-only, active subscription, seat availability.
 * Creates (or re-activates) a Firebase Auth user + Firestore user doc + seat
 * record in a single transaction. Returns a temp password the owner shares.
 */
export const inviteStaff = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { clinicId, email, displayName } = request.data as {
    clinicId: string;
    email: string;
    displayName: string;
  };

  if (!clinicId || !email || !displayName) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'clinicId, email, and displayName are required',
    );
  }

  const db = admin.firestore();

  // Verify caller is the clinic owner
  const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
  const caller = callerSnap.data();
  if (!caller || caller.role !== 'owner' || caller.clinicId !== clinicId) {
    throw new functions.https.HttpsError('permission-denied', 'Only the clinic owner can invite staff');
  }

  // Enforce seat availability and subscription status server-side
  const [subSnap, clinicSnap] = await Promise.all([
    db.doc(`subscriptions/${clinicId}`).get(),
    db.doc(`clinics/${clinicId}`).get(),
  ]);

  const sub = subSnap.data();
  const clinic = clinicSnap.data();

  if (!sub || sub.status !== 'active') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      sub?.status === 'grace_period'
        ? 'Resolve your billing issue before adding new staff.'
        : 'No active subscription. Upgrade your plan to invite staff.',
    );
  }

  if (!clinic || clinic.seats.used >= clinic.seats.max) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Seat limit reached (${clinic?.seats.used ?? 0}/${clinic?.seats.max ?? 0}). ` +
        'Upgrade your plan or purchase the Extra Seats add-on.',
    );
  }

  // Generate a temporary password
  const tempPassword =
    Math.random().toString(36).slice(-8) +
    Math.random().toString(36).slice(-4).toUpperCase();

  // Create a new Auth user, or reset the password if they already have an account
  let uid: string;
  try {
    const created = await admin.auth().createUser({ email, password: tempPassword, displayName });
    uid = created.uid;
  } catch (err: any) {
    if (err.code === 'auth/email-already-exists') {
      const existing = await admin.auth().getUserByEmail(email);
      uid = existing.uid;
      await admin.auth().updateUser(uid, { password: tempPassword, displayName });
    } else {
      throw new functions.https.HttpsError('internal', `Auth error: ${err.message}`);
    }
  }

  // Atomically create user doc + seat record + increment seat counter
  const userRef = db.doc(`users/${uid}`);
  const seatRef = db.doc(`seats/${clinicId}/members/${uid}`);
  const clinicRef = db.doc(`clinics/${clinicId}`);

  await db.runTransaction(async (tx) => {
    tx.set(userRef, {
      displayName,
      email,
      role: 'staff',
      clinicId,
      createdAt: Timestamp.now(),
    });
    tx.set(seatRef, {
      role: 'staff',
      active: true,
      joinedAt: Timestamp.now(),
    });
    tx.update(clinicRef, { 'seats.used': FieldValue.increment(1) });
  });

  return { tempPassword };
});
