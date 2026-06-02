const { getDb, FieldValue } = require('../utils/db');
const { checkDrawdown } = require('../utils/helpers');

/**
 * Increment strategy-level realized P&L stats after a closing trade.
 */
async function applyRealizedPnlToStrategy(strategyRef, realizedPnlUsd) {
  if (realizedPnlUsd == null || Number.isNaN(realizedPnlUsd)) return;

  const updates = {
    'stats.totalRealizedPnlUsd': FieldValue.increment(realizedPnlUsd),
  };
  if (realizedPnlUsd > 0) {
    updates['stats.winCount'] = FieldValue.increment(1);
  } else if (realizedPnlUsd < 0) {
    updates['stats.lossCount'] = FieldValue.increment(1);
  } else {
    updates['stats.breakEvenCount'] = FieldValue.increment(1);
  }
  await strategyRef.update(updates);
}

/**
 * Recompute realized P&L aggregates from closing trades (backfill / repair).
 */
async function recomputeStrategyStatsFromTrades(userId, strategyId) {
  const strategyRef = getDb().doc(`users/${userId}/strategies/${strategyId}`);
  const tradesSnap = await getDb()
    .collection(`users/${userId}/strategies/${strategyId}/trades`)
    .where('isClosingTrade', '==', true)
    .get();

  let totalRealizedPnlUsd = 0;
  let winCount = 0;
  let lossCount = 0;
  let breakEvenCount = 0;

  for (const doc of tradesSnap.docs) {
    const pnl = doc.data().realizedPnlUsd;
    if (pnl == null) continue;
    totalRealizedPnlUsd += pnl;
    if (pnl > 0) winCount += 1;
    else if (pnl < 0) lossCount += 1;
    else breakEvenCount += 1;
  }

  const allTradesSnap = await getDb()
    .collection(`users/${userId}/strategies/${strategyId}/trades`)
    .get();

  await strategyRef.update({
    'stats.totalRealizedPnlUsd': totalRealizedPnlUsd,
    'stats.winCount': winCount,
    'stats.lossCount': lossCount,
    'stats.breakEvenCount': breakEvenCount,
    'stats.totalTrades': allTradesSnap.size,
  });

  return {
    strategyId,
    totalRealizedPnlUsd,
    winCount,
    lossCount,
    breakEvenCount,
    closingTrades: tradesSnap.size,
    totalTrades: allTradesSnap.size,
  };
}

async function syncAllStrategyStatsForUser(userId) {
  const strategies = await getDb()
    .collection(`users/${userId}/strategies`)
    .where('status', 'in', ['active', 'paused', 'auto_paused'])
    .get();

  const results = [];
  for (const doc of strategies.docs) {
    results.push(await recomputeStrategyStatsFromTrades(userId, doc.id));
  }
  return results;
}

function portfolioDrawdownUpdates(strategy, portfolioSnapshot, peakOverride) {
  const peak = peakOverride ?? Math.max(
    strategy.stats?.peakPortfolioValueUsd ?? 0,
    portfolioSnapshot.totalValueUsd,
  );
  const drawdown = checkDrawdown(
    portfolioSnapshot,
    { ...strategy, stats: { ...strategy.stats, peakPortfolioValueUsd: peak } },
  );
  return {
    'stats.peakPortfolioValueUsd': peak,
    'stats.currentDrawdownPct': drawdown.currentDrawdownPct,
    'stats.maxDrawdownPct': Math.max(strategy.stats?.maxDrawdownPct ?? 0, drawdown.currentDrawdownPct),
  };
}

module.exports = {
  applyRealizedPnlToStrategy,
  recomputeStrategyStatsFromTrades,
  syncAllStrategyStatsForUser,
  portfolioDrawdownUpdates,
};
