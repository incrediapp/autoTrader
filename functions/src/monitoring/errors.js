const { logger } = require('firebase-functions');
const { getDb, FieldValue } = require('../utils/db');
const { generateErrorId } = require('../utils/helpers');
const { maskSecrets, sanitiseMetadata } = require('../utils/sanitise');

async function logError({
  source,
  severity,
  userId = null,
  strategyId = null,
  cycleId = null,
  tradeId = null,
  message,
  stack = null,
  errorCode = null,
  retryable = false,
  metadata = {},
  alertAdmin = false,
}) {
  const errorId = generateErrorId();

  logger.error(message, {
    event: 'APP_ERROR',
    errorId,
    source,
    severity,
    userId,
    strategyId,
    errorCode,
    retryable,
  });

  const errorDoc = {
    errorId,
    source,
    severity,
    userId,
    strategyId,
    cycleId,
    tradeId,
    message: String(message).slice(0, 1000),
    errorCode,
    stack: stack?.split('\n').slice(0, 8).join('\n').slice(0, 2000) ?? null,
    retryable,
    metadata: maskSecrets(sanitiseMetadata(metadata)),
    occurredAt: FieldValue.serverTimestamp(),
    resolved: false,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    alertSent: false,
    alertSentAt: null,
    expireAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  };

  await getDb().collection('errorLogs').doc(errorId).set(errorDoc);

  if (severity === 'critical' || alertAdmin) {
    await alertAdminOfCriticalError(errorDoc);
  }

  try {
    await getDb().doc('systemMetrics/current').update({
      errorCyclesToday: FieldValue.increment(1),
    });
  } catch {
    // metrics doc may not exist yet
  }

  return errorId;
}

async function alertAdminOfCriticalError(error) {
  const { sendFCMToTokens } = require('../notifications/fcm');
  const admins = await getDb().collection('users').where('role', '==', 'admin').get();
  const tokens = admins.docs
    .flatMap((d) => d.data().notifications?.fcmTokens ?? [])
    .filter(Boolean);

  if (tokens.length === 0) return;

  await sendFCMToTokens(tokens, {
    title: `Critical Error: ${error.source}`,
    body: error.message.slice(0, 100),
    data: {
      type: 'admin_critical_error',
      errorId: error.errorId,
    },
  });

  await getDb().collection('errorLogs').doc(error.errorId).update({
    alertSent: true,
    alertSentAt: FieldValue.serverTimestamp(),
  });
}

module.exports = {
  logError,
  alertAdminOfCriticalError,
};
