const { HttpsError } = require('firebase-functions/v2/https');
const { nanoid } = require('nanoid');
const { getDb, FieldValue } = require('../utils/db');
const { enforceRateLimit } = require('../utils/rateLimit');

const SUBCOLLECTIONS = [
  'cycles',
  'trades',
  'positions',
  'autopilotReports',
  'shadowConfigs',
  'shadowTrades',
  'monteCarloResults',
];

function isGuestUser(userData) {
  if (!userData) return false;
  const email = (userData.email ?? '').trim();
  return !email;
}

function cloneStrategyForTarget(data, targetUserId, newStrategyId, withHistory) {
  const copy = JSON.parse(JSON.stringify(data));

  copy.strategyId = newStrategyId;
  copy.userId = targetUserId;

  if (!withHistory) {
    copy.mode = 'paper';
    copy.liveEnabledAt = null;
    copy.paperStartedAt = FieldValue.serverTimestamp();
    copy.lastCycleAt = null;
    copy.lastCycleId = null;
    copy.lastTradeAt = null;
    copy.lastTradeId = null;
    copy.pendingOrderIds = [];
    copy.brokerHealth = {
      lastSuccessfulCycleAt: null,
      consecutiveFailures: 0,
      brokerUnreachable: false,
      brokerUnreachableAt: null,
    };
    copy.stats = {
      totalCycles: 0,
      totalCyclesWithTrade: 0,
      totalCyclesWithError: 0,
      avgCycleDurationMs: 0,
      totalTrades: 0,
      totalLiveTrades: 0,
      totalPaperTrades: 0,
      openPositionsCount: 0,
      winCount: 0,
      lossCount: 0,
      breakEvenCount: 0,
      totalRealizedPnlUsd: 0,
      totalFeesUsd: 0,
      totalTradeNotionalUsd: 0,
      largestWinUsd: 0,
      largestLossUsd: 0,
      avgWinUsd: 0,
      avgLossUsd: 0,
      profitFactor: null,
      peakPortfolioValueUsd: 0,
      currentDrawdownPct: 0,
      maxDrawdownPct: 0,
      maxDrawdownStartAt: null,
      maxDrawdownEndAt: null,
      sharpeRatio: null,
      sortinoRatio: null,
      lastRiskMetricsComputedAt: null,
      claudeApiCalls: 0,
      claudeApiCostUsd: 0,
      claudeAvgCostPerCycleUsd: 0,
    };
  }

  copy.updatedAt = FieldValue.serverTimestamp();
  if (!copy.createdAt) {
    copy.createdAt = FieldValue.serverTimestamp();
  }

  return copy;
}

async function copyCollection(db, sourcePath, targetPath) {
  const snap = await db.collection(sourcePath).get();
  if (snap.empty) return 0;

  const batchSize = 400;
  let written = 0;
  for (let i = 0; i < snap.docs.length; i += batchSize) {
    const batch = db.batch();
    const chunk = snap.docs.slice(i, i + batchSize);
    for (const doc of chunk) {
      batch.set(db.doc(`${targetPath}/${doc.id}`), doc.data());
      written += 1;
    }
    await batch.commit();
  }
  return written;
}

async function copyReplaySessions(db, sourceStrategyPath, targetStrategyPath) {
  const sessions = await db.collection(`${sourceStrategyPath}/replaySessions`).get();
  if (sessions.empty) return 0;

  let count = 0;
  for (const sessionDoc of sessions.docs) {
    await db.doc(`${targetStrategyPath}/replaySessions/${sessionDoc.id}`).set(sessionDoc.data());
    const stepsCopied = await copyCollection(
      db,
      `${sourceStrategyPath}/replaySessions/${sessionDoc.id}/steps`,
      `${targetStrategyPath}/replaySessions/${sessionDoc.id}/steps`,
    );
    count += 1 + stepsCopied;
  }
  return count;
}

async function copyOneStrategy(db, sourceUserId, targetUserId, sourceStrategyId, withHistory) {
  const sourceRef = db.doc(`users/${sourceUserId}/strategies/${sourceStrategyId}`);
  const sourceSnap = await sourceRef.get();
  if (!sourceSnap.exists) {
    throw new Error(`Strategy not found: ${sourceStrategyId}`);
  }

  const newStrategyId = nanoid(12);
  const targetRef = db.doc(`users/${targetUserId}/strategies/${newStrategyId}`);
  const strategyData = cloneStrategyForTarget(
    sourceSnap.data(),
    targetUserId,
    newStrategyId,
    withHistory,
  );

  await targetRef.set(strategyData);

  const copied = {
    sourceStrategyId,
    newStrategyId,
    name: strategyData.name,
    subcollections: {},
  };

  if (withHistory) {
    const sourceBase = `users/${sourceUserId}/strategies/${sourceStrategyId}`;
    const targetBase = `users/${targetUserId}/strategies/${newStrategyId}`;

    for (const sub of SUBCOLLECTIONS) {
      const n = await copyCollection(db, `${sourceBase}/${sub}`, `${targetBase}/${sub}`);
      if (n > 0) copied.subcollections[sub] = n;
    }

    const replayCount = await copyReplaySessions(db, sourceBase, targetBase);
    if (replayCount > 0) copied.subcollections.replaySessions = replayCount;
  }

  return copied;
}

async function bumpUserStats(db, targetUserId, count) {
  if (count <= 0) return;
  await db.doc(`users/${targetUserId}`).set({
    stats: {
      totalStrategies: FieldValue.increment(count),
      activeStrategies: FieldValue.increment(count),
      paperStrategies: FieldValue.increment(count),
    },
  }, { merge: true });
}

async function copyStrategiesBetweenUsers({
  sourceUserId,
  targetUserId,
  strategyIds = [],
  withHistory = true,
  db = getDb(),
}) {
  if (sourceUserId === targetUserId) {
    throw new Error('Source and target user must differ');
  }

  const dbRef = db;
  const [sourceUser, targetUser] = await Promise.all([
    dbRef.doc(`users/${sourceUserId}`).get(),
    dbRef.doc(`users/${targetUserId}`).get(),
  ]);

  if (!sourceUser.exists) throw new Error(`Source user not found: ${sourceUserId}`);
  if (!targetUser.exists) throw new Error(`Target user not found: ${targetUserId}`);

  const sourceStrategies = await dbRef.collection(`users/${sourceUserId}/strategies`).get();
  if (sourceStrategies.empty) {
    return { copied: [], message: 'No strategies to copy' };
  }

  const toCopy = strategyIds.length
    ? sourceStrategies.docs.filter((d) => strategyIds.includes(d.id))
    : sourceStrategies.docs;

  if (toCopy.length === 0) {
    throw new Error(`No matching strategies. Available: ${sourceStrategies.docs.map((d) => d.id).join(', ')}`);
  }

  const copied = [];
  for (const doc of toCopy) {
    copied.push(await copyOneStrategy(dbRef, sourceUserId, targetUserId, doc.id, withHistory));
  }

  await bumpUserStats(dbRef, targetUserId, copied.length);

  return {
    copied,
    sourceUserId,
    targetUserId,
    withHistory,
  };
}

async function migrateGuestStrategiesHandler(request) {
  const targetUserId = request.auth?.uid;
  if (!targetUserId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(targetUserId, 'migrate_guest_strategies');

  const {
    sourceUserId,
    withHistory = true,
    strategyIds = [],
  } = request.data ?? {};

  if (!sourceUserId || typeof sourceUserId !== 'string') {
    throw new HttpsError('invalid-argument', 'sourceUserId required');
  }

  if (sourceUserId === targetUserId) {
    throw new HttpsError('invalid-argument', 'sourceUserId must differ from your account');
  }

  const db = getDb();
  const sourceUser = await db.doc(`users/${sourceUserId}`).get();
  if (!sourceUser.exists) {
    throw new HttpsError('not-found', 'Source user not found');
  }

  if (!isGuestUser(sourceUser.data())) {
    throw new HttpsError(
      'permission-denied',
      'Import is only allowed from guest accounts (no email on profile)',
    );
  }

  try {
    const result = await copyStrategiesBetweenUsers({
      sourceUserId,
      targetUserId,
      strategyIds: Array.isArray(strategyIds) ? strategyIds : [],
      withHistory: withHistory !== false,
    });
    return result;
  } catch (err) {
    throw new HttpsError('internal', err.message ?? 'Migration failed');
  }
}

module.exports = {
  copyStrategiesBetweenUsers,
  migrateGuestStrategiesHandler,
  isGuestUser,
};
