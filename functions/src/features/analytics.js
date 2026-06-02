const { getDb } = require('../utils/db');

const RANGE_MS = {
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000,
  '90D': 90 * 24 * 60 * 60 * 1000,
};

function rangeStart(range) {
  const ms = RANGE_MS[range];
  if (!ms) return null;
  return new Date(Date.now() - ms);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function aggregateStats(strategies) {
  let totalPnlUsd = 0;
  let winCount = 0;
  let lossCount = 0;
  let totalTrades = 0;
  let claudeCostUsd = 0;
  let maxDrawdownPct = 0;
  let sharpeSum = 0;
  let sharpeCount = 0;

  for (const s of strategies) {
    const stats = s.stats ?? {};
    totalPnlUsd += stats.totalRealizedPnlUsd ?? 0;
    winCount += stats.winCount ?? 0;
    lossCount += stats.lossCount ?? 0;
    totalTrades += stats.totalTrades ?? 0;
    claudeCostUsd += stats.claudeApiCostUsd ?? 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, stats.maxDrawdownPct ?? 0);
    if (stats.sharpeRatio != null) {
      sharpeSum += stats.sharpeRatio;
      sharpeCount += 1;
    }
  }

  const decided = winCount + lossCount;
  return {
    totalPnlUsd: round2(totalPnlUsd),
    totalPnlPct: 0,
    winRate: decided > 0 ? round2((winCount / decided) * 100) : 0,
    winCount,
    totalTrades,
    sharpeRatio: sharpeCount > 0 ? round2(sharpeSum / sharpeCount) : null,
    maxDrawdownPct: round2(maxDrawdownPct),
    claudeCostUsd: round2(claudeCostUsd),
  };
}

function buildEquityAndDrawdown(trades, startingCapital = 0) {
  let equity = startingCapital;
  let peak = equity;
  const equityCurve = [];
  const drawdownSeries = [];

  for (const trade of trades) {
    if (trade.isClosingTrade !== true) continue;
    const pnl = trade.realizedPnlUsd ?? 0;
    const executedAt = trade.executedAt?.toDate?.() ?? trade.executedAt;
    if (!executedAt) continue;

    equity += pnl;
    peak = Math.max(peak, equity);
    const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    equityCurve.push({
      date: executedAt.toISOString(),
      value: round2(equity),
      strategyId: trade.strategyId ?? null,
    });
    drawdownSeries.push({
      date: executedAt.toISOString(),
      value: round2(-ddPct),
    });
  }

  return { equityCurve, drawdownSeries };
}

function buildPnlByAsset(trades) {
  const bySymbol = {};
  for (const t of trades) {
    if (t.isClosingTrade !== true) continue;
    const sym = t.symbol ?? 'UNKNOWN';
    bySymbol[sym] = (bySymbol[sym] ?? 0) + (t.realizedPnlUsd ?? 0);
  }
  return Object.entries(bySymbol).map(([symbol, pnlUsd]) => ({
    symbol,
    pnlUsd: round2(pnlUsd),
  }));
}

function buildTradeFrequency(trades) {
  const byDay = {};
  for (const t of trades) {
    const executedAt = t.executedAt?.toDate?.() ?? t.executedAt;
    if (!executedAt) continue;
    const day = executedAt.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }
  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}

function buildClaudeCostPerDay() {
  return [];
}

async function loadTradesForStrategy(userId, strategyId, { mode, since }) {
  let query = getDb()
    .collection(`users/${userId}/strategies/${strategyId}/trades`);

  if (mode) {
    query = query.where('mode', '==', mode);
  }
  if (since) {
    query = query.where('executedAt', '>=', since);
  }

  const snap = await query.orderBy('executedAt', 'asc').limit(2000).get();
  return snap.docs.map((d) => ({
    ...d.data(),
    tradeId: d.id,
    strategyId,
  }));
}

function tradeExecutedAtMs(trade) {
  const t = trade.executedAt?.toDate?.() ?? trade.executedAt;
  if (!t) return 0;
  return t instanceof Date ? t.getTime() : new Date(t).getTime();
}

async function loadTrades(userId, { strategyId, mode, since }, strategyIds = []) {
  const ids = strategyId ? [strategyId] : strategyIds;
  const batches = await Promise.all(
    ids.map((id) => loadTradesForStrategy(userId, id, { mode, since })),
  );

  return batches
    .flat()
    .sort((a, b) => tradeExecutedAtMs(a) - tradeExecutedAtMs(b))
    .slice(0, 2000);
}

async function getAnalyticsHandler(userId, data = {}) {
  const { range = '30D', strategyId, mode } = data;
  const since = rangeStart(range);

  const strategiesSnap = strategyId
    ? [await getDb().doc(`users/${userId}/strategies/${strategyId}`).get()]
    : (await getDb()
      .collection(`users/${userId}/strategies`)
      .get()).docs;

  const strategies = strategiesSnap
    .filter((d) => d.exists && d.data()?.status !== 'archived')
    .map((d) => ({ strategyId: d.id, ...d.data() }));

  const summary = aggregateStats(strategies);
  const trades = await loadTrades(
    userId,
    { strategyId, mode, since },
    strategies.map((s) => s.strategyId),
  );
  const { equityCurve, drawdownSeries } = buildEquityAndDrawdown(trades);

  const strategyComparison = strategies.map((s) => {
    const stats = s.stats ?? {};
    const decided = (stats.winCount ?? 0) + (stats.lossCount ?? 0);
    return {
      strategyId: s.strategyId,
      name: s.name ?? s.strategyId,
      trades: stats.totalTrades ?? 0,
      winRate: decided > 0 ? round2(((stats.winCount ?? 0) / decided) * 100) : 0,
      pnlUsd: round2(stats.totalRealizedPnlUsd ?? 0),
      sharpe: stats.sharpeRatio ?? null,
      maxDrawdownPct: round2(stats.maxDrawdownPct ?? 0),
      claudeCostUsd: round2(stats.claudeApiCostUsd ?? 0),
      mode: s.mode ?? 'paper',
    };
  });

  return {
    ...summary,
    equityCurve,
    drawdownSeries,
    pnlByAsset: buildPnlByAsset(trades),
    tradeDistribution: [],
    tradeFrequency: buildTradeFrequency(trades),
    claudeCostPerDay: buildClaudeCostPerDay(),
    strategyComparison,
    range,
    strategyId: strategyId ?? null,
    mode: mode ?? null,
    tradeCountInRange: trades.length,
  };
}

module.exports = {
  getAnalyticsHandler,
  rangeStart,
};
