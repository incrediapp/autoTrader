const { getDb, FieldValue } = require('../utils/db');

async function updatePositionAfterTrade(strategy, userId, decision, qty, price, tradeId) {
  const posRef = getDb().doc(
    `users/${userId}/strategies/${strategy.strategyId}/positions/${decision.symbol}`,
  );

  await getDb().runTransaction(async (tx) => {
    const posDoc = await tx.get(posRef);

    if (decision.side === 'buy') {
      const existing = posDoc.exists ? posDoc.data() : {
        symbol: decision.symbol,
        quantity: 0,
        avgCostUsd: 0,
        totalCostBasisUsd: 0,
        lotsFIFO: [],
        openedAt: FieldValue.serverTimestamp(),
      };

      const newQuantity = existing.quantity + qty;
      const newCostBasis = existing.totalCostBasisUsd + (qty * price);
      const newAvgCost = newQuantity > 0 ? newCostBasis / newQuantity : 0;

      tx.set(posRef, {
        ...existing,
        symbol: decision.symbol,
        strategyId: strategy.strategyId,
        userId,
        broker: strategy.assets?.broker ?? 'binance',
        quantity: newQuantity,
        avgCostUsd: newAvgCost,
        totalCostBasisUsd: newCostBasis,
        currentPriceUsd: price,
        currentValueUsd: newQuantity * price,
        unrealizedPnlUsd: newQuantity * price - newCostBasis,
        unrealizedPnlPct: newCostBasis > 0 ? ((newQuantity * price - newCostBasis) / newCostBasis) * 100 : 0,
        lotsFIFO: [...(existing.lotsFIFO ?? []), {
          tradeId,
          quantity: qty,
          costPerUnit: price,
          acquiredAt: new Date(),
          remainingQty: qty,
        }],
        lastUpdatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      if (!posDoc.exists) throw new Error(`No position to sell: ${decision.symbol}`);

      const pos = posDoc.data();
      let remainingToSell = qty;
      const lots = [...(pos.lotsFIFO ?? [])];
      let totalCostBasisClosed = 0;
      const openingTradeIds = [];

      for (const lot of lots) {
        if (remainingToSell <= 0) break;
        const closeQty = Math.min(lot.remainingQty, remainingToSell);
        lot.remainingQty -= closeQty;
        totalCostBasisClosed += closeQty * lot.costPerUnit;
        remainingToSell -= closeQty;
        if (closeQty > 0) openingTradeIds.push(lot.tradeId);
      }

      const newQuantity = pos.quantity - qty;
      const newCostBasis = pos.totalCostBasisUsd - totalCostBasisClosed;
      const proceeds = qty * price;
      const realizedPnl = proceeds - totalCostBasisClosed;

      const tradeRef = getDb().doc(
        `users/${userId}/strategies/${strategy.strategyId}/trades/${tradeId}`,
      );

      tx.update(tradeRef, {
        isClosingTrade: true,
        openingTradeIds,
        costBasisUsd: totalCostBasisClosed,
        proceedsUsd: proceeds,
        netProceedsUsd: proceeds,
        realizedPnlUsd: realizedPnl,
        realizedPnlPct: totalCostBasisClosed > 0 ? (realizedPnl / totalCostBasisClosed) * 100 : 0,
        holdingPeriodMs: null,
        acquisitionDate: lots[0]?.acquiredAt ?? null,
        isShortTermGain: true,
      });

      if (newQuantity <= 0.000001) {
        tx.delete(posRef);
      } else {
        tx.update(posRef, {
          quantity: newQuantity,
          avgCostUsd: newQuantity > 0 ? newCostBasis / newQuantity : 0,
          totalCostBasisUsd: newCostBasis,
          lotsFIFO: lots.filter((l) => l.remainingQty > 0.000001),
          currentPriceUsd: price,
          currentValueUsd: newQuantity * price,
          unrealizedPnlUsd: newQuantity * price - newCostBasis,
          unrealizedPnlPct: newCostBasis > 0 ? ((newQuantity * price - newCostBasis) / newCostBasis) * 100 : 0,
          lastUpdatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
  });
}

module.exports = {
  updatePositionAfterTrade,
};
