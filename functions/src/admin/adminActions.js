const { HttpsError } = require('firebase-functions/v2/https');
const { getDb, FieldValue } = require('../utils/db');
const { enforceRateLimit } = require('../utils/rateLimit');

async function verifyAdmin(userId) {
  const userDoc = await getDb().doc(`users/${userId}`).get();
  if (!userDoc.exists || userDoc.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
  return userDoc.data();
}

async function writeAuditLog(adminUserId, adminEmail, action, targetType, targetId, before, after) {
  await getDb().collection('adminAuditLog').add({
    adminUserId,
    adminEmail,
    action,
    targetType,
    targetId,
    before,
    after,
    ipAddress: null,
    userAgent: null,
    performedAt: FieldValue.serverTimestamp(),
  });
}

async function adminSuspendUserHandler(request) {
  const adminId = request.auth?.uid;
  if (!adminId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(adminId, 'admin_suspend_user');
  const admin = await verifyAdmin(adminId);

  const { targetUserId, reason } = request.data ?? {};
  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId required');

  const userRef = getDb().doc(`users/${targetUserId}`);
  const before = (await userRef.get()).data();

  await userRef.update({
    status: 'suspended',
    suspendedAt: FieldValue.serverTimestamp(),
    suspendedReason: reason ?? 'Suspended by admin',
  });

  await writeAuditLog(adminId, admin.email, 'suspend_user', 'user', targetUserId, before, { status: 'suspended' });

  return { targetUserId, status: 'suspended' };
}

async function adminPromoteUserHandler(request) {
  const adminId = request.auth?.uid;
  if (!adminId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(adminId, 'admin_promote_user');
  const admin = await verifyAdmin(adminId);

  const { targetUserId, role = 'admin' } = request.data ?? {};
  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId required');

  const userRef = getDb().doc(`users/${targetUserId}`);
  const before = (await userRef.get()).data();

  await userRef.update({ role });

  await writeAuditLog(adminId, admin.email, 'promote_user', 'user', targetUserId, before, { role });

  return { targetUserId, role };
}

async function adminResolveErrorHandler(request) {
  const adminId = request.auth?.uid;
  if (!adminId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(adminId, 'admin_resolve_error');
  await verifyAdmin(adminId);

  const { errorId, resolutionNote } = request.data ?? {};
  if (!errorId) throw new HttpsError('invalid-argument', 'errorId required');

  const errorRef = getDb().collection('errorLogs').doc(errorId);
  const before = (await errorRef.get()).data();

  await errorRef.update({
    resolved: true,
    resolvedAt: FieldValue.serverTimestamp(),
    resolvedByAdminId: adminId,
    resolutionNote: resolutionNote ?? null,
  });

  return { errorId, resolved: true, before };
}

module.exports = {
  verifyAdmin,
  adminSuspendUserHandler,
  adminPromoteUserHandler,
  adminResolveErrorHandler,
  writeAuditLog,
};
