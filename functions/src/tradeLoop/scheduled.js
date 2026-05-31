const { onSchedule } = require('firebase-functions/v2/scheduler');
const { withAppSecrets } = require('../config/secrets');
const pLimit = require('p-limit');
const { nanoid } = require('nanoid');
const { getDb } = require('../utils/db');
const { isWithinActiveHours } = require('../utils/helpers');
const { runStrategyLoop, previewStrategyDecision } = require('./strategyRunner');
const { detectAndResolveConflicts } = require('../features/conflicts');
const { createLogContext, logInfo, logCycleSummary } = require('../monitoring/logger');
const { logError } = require('../monitoring/errors');

async function runTradeLoopBatch(triggeredBy, runId) {
  const ctx = createLogContext('tradeLoopScheduled');
  const startedAt = Date.now();

  logInfo(ctx, `[TradeLoop] Run ${runId} starting`);

  const snapshot = await getDb()
    .collectionGroup('strategies')
    .where('status', '==', 'active')
    .get();

  const strategies = snapshot.docs.map((d) => ({ ...d.data(), _ref: d.ref }));
  const now = new Date();
  const eligible = strategies.filter((s) => isWithinActiveHours(s, now));

  logInfo(ctx, `[TradeLoop] Run ${runId}: ${strategies.length} active, ${eligible.length} eligible`);

  const { eligibleAfterConflicts } = await detectAndResolveConflicts(eligible);

  const limit = pLimit(10);
  const results = await Promise.all(
    eligibleAfterConflicts.map((strategy) =>
      limit(() => runStrategyLoop(strategy, triggeredBy, runId)),
    ),
  );

  const errors = results.filter((r) => r.error);
  const trades = results.filter((r) => r.tradeExecuted);

  logCycleSummary(ctx, {
    runId,
    totalStrategies: strategies.length,
    eligibleStrategies: eligibleAfterConflicts.length,
    tradeCount: trades.length,
    errorCount: errors.length,
    durationMs: Date.now() - startedAt,
  });

  if (eligibleAfterConflicts.length > 0 && errors.length / eligibleAfterConflicts.length > 0.2) {
    await logError({
      source: 'trade_loop',
      severity: 'critical',
      message: `High error rate in run ${runId}: ${errors.length}/${eligibleAfterConflicts.length} strategies failed`,
      metadata: { runId, errorStrategies: errors.map((e) => e.strategyId) },
    });
  }

  return results;
}

const tradeLoopScheduled = onSchedule(withAppSecrets({
  schedule: 'every 15 minutes',
  timeZone: 'UTC',
  maxInstances: 5,
  timeoutSeconds: 540,
  memory: '1GiB',
}), async () => {
  const runId = nanoid(8);
  await runTradeLoopBatch('schedule', runId);
});

module.exports = {
  tradeLoopScheduled,
  runTradeLoopBatch,
  previewStrategyDecision,
};
