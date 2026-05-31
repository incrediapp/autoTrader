const { getDb, FieldValue } = require('../utils/db');
const { nanoid } = require('../utils/helpers');
const { fetchOHLCV } = require('../brokers/adapter');
const { buildAssetSnapshot } = require('../tradeLoop/indicators');
const { getClaudeDecision } = require('../claude/decision');
const { validateDecision } = require('../tradeLoop/validation');

function generateTimeSteps(startDate, endDate, intervalMinutes) {
  const steps = [];
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const intervalMs = intervalMinutes * 60 * 1000;

  for (let t = start; t <= end; t += intervalMs) {
    steps.push(new Date(t));
  }
  return steps;
}

function buildHistoricalMarketSnapshot(allCandles, stepTime, watchlist) {
  const assets = [];
  for (const symbol of watchlist) {
    const candles = allCandles[symbol]?.filter((c) => c.t <= stepTime.getTime()) ?? [];
    if (candles.length < 50) continue;
    assets.push(buildAssetSnapshot(symbol, candles.slice(-200), stepTime.getTime()));
  }

  return {
    fetchedAt: stepTime,
    dataFreshnessMs: 0,
    dataStale: assets.length === 0,
    assets,
  };
}

function simulateTrade(decision, marketSnapshot, _portfolio) {
  const asset = marketSnapshot.assets.find((a) => a.symbol === decision.symbol);
  if (!asset) return null;

  const qty = decision.notionalUsd / asset.price;
  return {
    symbol: decision.symbol,
    side: decision.side,
    executedQuantity: qty,
    executedPriceUsd: asset.price,
    executedNotionalUsd: decision.notionalUsd,
  };
}

function updateSimulatedPortfolio(portfolio, trade) {
  const p = { ...portfolio, positions: [...(portfolio.positions ?? [])] };

  if (trade.side === 'buy') {
    p.cashUsd -= trade.executedNotionalUsd;
    const existing = p.positions.find((pos) => pos.symbol === trade.symbol);
    if (existing) {
      existing.quantity += trade.executedQuantity;
      existing.currentValueUsd += trade.executedNotionalUsd;
    } else {
      p.positions.push({
        symbol: trade.symbol,
        quantity: trade.executedQuantity,
        currentValueUsd: trade.executedNotionalUsd,
        avgCostUsd: trade.executedPriceUsd,
      });
    }
  } else {
    const existing = p.positions.find((pos) => pos.symbol === trade.symbol);
    if (existing) {
      existing.quantity -= trade.executedQuantity;
      existing.currentValueUsd -= trade.executedNotionalUsd;
      p.cashUsd += trade.executedNotionalUsd;
      if (existing.quantity <= 0) {
        p.positions = p.positions.filter((pos) => pos.symbol !== trade.symbol);
      }
    }
  }

  p.totalValueUsd = p.cashUsd + p.positions.reduce((s, pos) => s + pos.currentValueUsd, 0);
  return p;
}

async function generateReplaySessionHandler(userId, { strategyId, startDate, endDate }) {
  const sessionId = `${Date.now()}_${nanoid(6)}`;
  const sessionRef = getDb().doc(
    `users/${userId}/strategies/${strategyId}/replaySessions/${sessionId}`,
  );

  await sessionRef.set({
    sessionId,
    strategyId,
    userId,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    intervalMinutes: 15,
    status: 'generating',
    progress: 0,
    totalSteps: 0,
    completedSteps: 0,
    generatedAt: null,
    expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const strategy = (await getDb().doc(`users/${userId}/strategies/${strategyId}`).get()).data();
  const isPaper = strategy.mode === 'paper';

  const allCandles = {};
  for (const symbol of strategy.assets.watchlist) {
    allCandles[symbol] = await fetchOHLCV(
      strategy.assets.broker,
      userId,
      symbol,
      '15m',
      500,
      isPaper,
    );
  }

  const timeSteps = generateTimeSteps(startDate, endDate, 15);
  await sessionRef.update({ totalSteps: timeSteps.length });

  let simulatedPortfolio = { totalValueUsd: 20, cashUsd: 20, positions: [] };

  for (let i = 0; i < timeSteps.length; i++) {
    const stepTime = timeSteps[i];
    const marketSnapshot = buildHistoricalMarketSnapshot(allCandles, stepTime, strategy.assets.watchlist);

    if (marketSnapshot.dataStale) continue;

    let claudeResult;
    try {
      claudeResult = await getClaudeDecision(strategy, simulatedPortfolio, marketSnapshot);
    } catch {
      claudeResult = { decision: { action: 'hold', reasoning: 'Claude unavailable' }, claudeCalled: false, costUsd: 0 };
    }

    const { decision } = validateDecision(claudeResult.decision, strategy, simulatedPortfolio, marketSnapshot);

    let trade = null;
    if (decision.action === 'buy' || decision.action === 'sell') {
      trade = simulateTrade(decision, marketSnapshot, simulatedPortfolio);
      if (trade) simulatedPortfolio = updateSimulatedPortfolio(simulatedPortfolio, trade);
    }

    await sessionRef.collection('steps').doc(String(i).padStart(6, '0')).set({
      stepIndex: i,
      timestamp: stepTime,
      marketSnapshot,
      portfolioSnapshot: { ...simulatedPortfolio },
      decision,
      tradeExecuted: trade !== null,
      trade,
      claudeCalled: claudeResult.claudeCalled ?? false,
      claudeCostUsd: claudeResult.costUsd ?? 0,
    });

    if (i % 10 === 0) {
      await sessionRef.update({
        progress: Math.round((i / timeSteps.length) * 100),
        completedSteps: i,
      });
    }
  }

  await sessionRef.update({
    status: 'ready',
    progress: 100,
    completedSteps: timeSteps.length,
    generatedAt: FieldValue.serverTimestamp(),
  });

  return { sessionId };
}

module.exports = {
  generateReplaySessionHandler,
  generateTimeSteps,
  buildHistoricalMarketSnapshot,
  simulateTrade,
  updateSimulatedPortfolio,
};
