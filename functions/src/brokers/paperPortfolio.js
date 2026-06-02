const { getDb } = require('../utils/db');

/**
 * Simulated portfolio for strategy.mode === 'paper' (Firestore positions + paper cash).
 */
async function fetchPaperPortfolioFromFirestore(strategy, userId, broker, getSpotPrice) {
  const strategyId = strategy.strategyId ?? strategy.id;
  if (!strategyId) {
    throw new Error('paper portfolio requires strategyId on context');
  }

  const positionsSnap = await getDb()
    .collection(`users/${userId}/strategies/${strategyId}/positions`)
    .get();

  const positions = [];
  for (const doc of positionsSnap.docs) {
    const p = doc.data();
    if ((p.quantity ?? 0) <= 0) continue;
    let price = p.currentPriceUsd ?? p.avgCostUsd ?? 0;
    try {
      price = await getSpotPrice(p.symbol);
    } catch {
      // keep last known price
    }
    const value = p.quantity * price;
    positions.push({
      symbol: p.symbol,
      quantity: p.quantity,
      avgCostUsd: p.avgCostUsd ?? price,
      currentPriceUsd: price,
      currentValueUsd: value,
      unrealizedPnlUsd: value - (p.quantity * (p.avgCostUsd ?? price)),
      unrealizedPnlPct: p.avgCostUsd > 0
        ? ((price - p.avgCostUsd) / p.avgCostUsd) * 100
        : 0,
      openingTradeId: p.openingTradeId ?? null,
    });
  }

  const positionsValue = positions.reduce((s, p) => s + p.currentValueUsd, 0);
  const cashUsd = strategy.stats?.paperCashUsd ?? 10000;
  const totalValueUsd = cashUsd + positionsValue;

  return {
    fetchedAt: new Date(),
    broker,
    totalValueUsd,
    cashUsd,
    positions,
    simulated: true,
    simulationReason: 'paper_mode_firestore_snapshot',
  };
}

module.exports = {
  fetchPaperPortfolioFromFirestore,
};
