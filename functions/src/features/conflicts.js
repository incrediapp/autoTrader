const { nanoid } = require('nanoid');
const { getDb, FieldValue } = require('../utils/db');
const { previewStrategyDecision } = require('../tradeLoop/strategyRunner');
const { sendNotification } = require('../notifications/fcm');

async function detectAndResolveConflicts(eligibleStrategies) {
  if (eligibleStrategies.length < 2) {
    return { eligibleAfterConflicts: eligibleStrategies, conflicts: [] };
  }

  const previews = await Promise.all(
    eligibleStrategies.map(async (strategy) => ({
      strategy,
      preview: (await previewStrategyDecision(strategy, strategy.userId)).preview,
    })),
  );

  const heldStrategyIds = new Set();
  const conflicts = [];

  for (let i = 0; i < previews.length; i++) {
    for (let j = i + 1; j < previews.length; j++) {
      const a = previews[i];
      const b = previews[j];

      if (a.preview.action !== 'buy' && a.preview.action !== 'sell') continue;
      if (b.preview.action !== 'buy' && b.preview.action !== 'sell') continue;

      const sameBroker = a.strategy.assets.broker === b.strategy.assets.broker;
      const sameUser = a.strategy.userId === b.strategy.userId;
      const sameSymbol = a.preview.symbol === b.preview.symbol;
      const opposingSides = a.preview.side !== b.preview.side;

      if (sameBroker && sameUser && sameSymbol && opposingSides) {
        const conflictId = nanoid(8);
        conflicts.push({ conflictId, a, b, symbol: a.preview.symbol });

        const userDoc = await getDb().doc(`users/${a.strategy.userId}`).get();
        const rule = userDoc.data()?.conflictResolution?.rule ?? 'hold_both';

        let resolution = 'held_both';
        let executedId = null;

        if (rule === 'higher_confidence') {
          const confA = a.preview.confidence ?? 0;
          const confB = b.preview.confidence ?? 0;
          if (confA > confB) {
            executedId = a.strategy.strategyId;
            resolution = 'executed_a';
            heldStrategyIds.add(b.strategy.strategyId);
          } else if (confB > confA) {
            executedId = b.strategy.strategyId;
            resolution = 'executed_b';
            heldStrategyIds.add(a.strategy.strategyId);
          } else {
            heldStrategyIds.add(a.strategy.strategyId);
            heldStrategyIds.add(b.strategy.strategyId);
          }
        } else if (rule === 'older_strategy') {
          const aCreated = a.strategy.createdAt?.toMillis?.() ?? 0;
          const bCreated = b.strategy.createdAt?.toMillis?.() ?? 0;
          if (aCreated <= bCreated) {
            executedId = a.strategy.strategyId;
            resolution = 'executed_a';
            heldStrategyIds.add(b.strategy.strategyId);
          } else {
            executedId = b.strategy.strategyId;
            resolution = 'executed_b';
            heldStrategyIds.add(a.strategy.strategyId);
          }
        } else if (rule === 'newer_strategy') {
          const aCreated = a.strategy.createdAt?.toMillis?.() ?? 0;
          const bCreated = b.strategy.createdAt?.toMillis?.() ?? 0;
          if (aCreated >= bCreated) {
            executedId = a.strategy.strategyId;
            resolution = 'executed_a';
            heldStrategyIds.add(b.strategy.strategyId);
          } else {
            executedId = b.strategy.strategyId;
            resolution = 'executed_b';
            heldStrategyIds.add(a.strategy.strategyId);
          }
        } else {
          heldStrategyIds.add(a.strategy.strategyId);
          heldStrategyIds.add(b.strategy.strategyId);
        }

        await getDb().collection(`users/${a.strategy.userId}/conflictLogs`).doc(conflictId).set({
          conflictId,
          userId: a.strategy.userId,
          symbol: a.preview.symbol,
          broker: a.strategy.assets.broker,
          strategyAId: a.strategy.strategyId,
          strategyAName: a.strategy.name,
          strategyADecision: a.preview,
          strategyBId: b.strategy.strategyId,
          strategyBName: b.strategy.name,
          strategyBDecision: b.preview,
          resolutionRule: rule,
          resolution,
          executedStrategyId: executedId,
          resolutionReason: resolution === 'held_both' ? 'Both held pending user resolution' : `Auto-resolved: ${rule}`,
          detectedAt: FieldValue.serverTimestamp(),
          resolvedAt: FieldValue.serverTimestamp(),
          expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });

        await sendNotification(a.strategy.userId, 'strategy_conflict', a.strategy, {
          symbol: a.preview.symbol,
          strategyAName: a.strategy.name,
          strategyBName: b.strategy.name,
          conflictId,
        });
      }
    }
  }

  const eligibleAfterConflicts = eligibleStrategies.filter(
    (s) => !heldStrategyIds.has(s.strategyId),
  );

  return { eligibleAfterConflicts, conflicts };
}

async function resolveConflictHandler(userId, { conflictId, executeStrategyId }) {
  const conflictDoc = await getDb()
    .collection(`users/${userId}/conflictLogs`)
    .doc(conflictId)
    .get();

  if (!conflictDoc.exists) throw new Error('Conflict not found');

  await conflictDoc.ref.update({
    resolution: executeStrategyId ? 'executed_manual' : 'held_both',
    resolutionReason: executeStrategyId ? `User chose strategy ${executeStrategyId}` : 'User chose hold both',
    resolvedAt: FieldValue.serverTimestamp(),
  });

  return { conflictId, executeStrategyId };
}

module.exports = {
  detectAndResolveConflicts,
  resolveConflictHandler,
};
