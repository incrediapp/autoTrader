#!/usr/bin/env node
/**
 * Backfill strategy.stats (realized P&L, win/loss counts) from trades subcollections.
 *
 * Usage:
 *   node scripts/recompute-strategy-stats.js [userId]
 *   node scripts/recompute-strategy-stats.js [userId] [strategyId]
 */
require('../functions/src/config/firebase');
const { syncAllStrategyStatsForUser, recomputeStrategyStatsFromTrades } = require('../functions/src/strategy/statsSync');

async function main() {
  const userId = process.argv[2];
  const strategyId = process.argv[3];
  if (!userId) {
    console.error('Usage: node scripts/recompute-strategy-stats.js <userId> [strategyId]');
    process.exit(1);
  }

  const results = strategyId
    ? [await recomputeStrategyStatsFromTrades(userId, strategyId)]
    : await syncAllStrategyStatsForUser(userId);

  for (const r of results) {
    console.log(
      `${r.strategyId}: realized=$${r.totalRealizedPnlUsd.toFixed(2)} `
      + `wins=${r.winCount} losses=${r.lossCount} trades=${r.totalTrades}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
