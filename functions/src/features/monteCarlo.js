const { gaussianRandom, buildHistogram, nanoid } = require('../utils/helpers');
const { getDb, FieldValue } = require('../utils/db');
const { HttpsError } = require('firebase-functions/v2/https');
const { enforceRateLimit } = require('../utils/rateLimit');
const { createLogContext, logErrorLog } = require('../monitoring/logger');

function deriveParamsFromTrades(trades) {
  const wins = trades.filter((t) => (t.realizedPnlPct ?? 0) > 0);
  const losses = trades.filter((t) => (t.realizedPnlPct ?? 0) <= 0);

  const winRate = trades.length > 0 ? wins.length / trades.length : 0.5;
  const avgWinPct = wins.length
    ? wins.reduce((s, t) => s + (t.realizedPnlPct ?? 0), 0) / wins.length / 100
    : 0.03;
  const avgLossPct = losses.length
    ? losses.reduce((s, t) => s + (t.realizedPnlPct ?? 0), 0) / losses.length / 100
    : -0.02;

  const winPcts = wins.map((t) => (t.realizedPnlPct ?? 0) / 100);
  const lossPcts = losses.map((t) => (t.realizedPnlPct ?? 0) / 100);

  const stdDev = (arr, mean) => {
    if (arr.length < 2) return 0.02;
    return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  };

  const tradesPerPeriod = Math.max(1, trades.length / 3);

  return {
    winRate,
    avgWinPct,
    avgLossPct,
    stdDevWinPct: stdDev(winPcts, avgWinPct) || 0.02,
    stdDevLossPct: stdDev(lossPcts, avgLossPct) || 0.01,
    tradesPerPeriod,
  };
}

function runSimulations({
  startingCapital,
  periodDays,
  simulationCount,
  winRate,
  avgWinPct,
  avgLossPct,
  stdDevWinPct,
  stdDevLossPct,
  tradesPerPeriod,
}) {
  const finalValues = [];
  const maxDrawdowns = [];
  const sampleCurves = [];
  const tradesTotal = Math.round(tradesPerPeriod * (periodDays / 30));

  for (let sim = 0; sim < simulationCount; sim++) {
    let capital = startingCapital;
    let peak = startingCapital;
    let maxDD = 0;
    const curve = [startingCapital];

    for (let t = 0; t < tradesTotal; t++) {
      const isWin = Math.random() < winRate;
      const pct = isWin
        ? avgWinPct + gaussianRandom() * stdDevWinPct
        : avgLossPct + gaussianRandom() * stdDevLossPct;

      capital = Math.max(0, capital * (1 + pct));
      if (capital > peak) peak = capital;
      const dd = peak > 0 ? (peak - capital) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      if (t % 5 === 0) curve.push(capital);
    }

    finalValues.push(capital);
    maxDrawdowns.push(maxDD * 100);
    if (sim < 20) sampleCurves.push(curve);
  }

  finalValues.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.floor(arr.length * p)] ?? arr[0];

  return {
    p5FinalValueUsd: pct(finalValues, 0.05),
    p25FinalValueUsd: pct(finalValues, 0.25),
    p50FinalValueUsd: pct(finalValues, 0.50),
    p75FinalValueUsd: pct(finalValues, 0.75),
    p95FinalValueUsd: pct(finalValues, 0.95),
    meanFinalValueUsd: finalValues.reduce((a, b) => a + b, 0) / finalValues.length,
    probabilityOfRuin20Pct: finalValues.filter((v) => v < startingCapital * 0.8).length / simulationCount,
    probabilityOfRuin50Pct: finalValues.filter((v) => v < startingCapital * 0.5).length / simulationCount,
    maxDrawdownDistribution: buildHistogram(maxDrawdowns, [0, 5, 10, 15, 20, 25, 30, 40, 50, 100]),
    equityCurves: sampleCurves,
    returnsHistogram: buildHistogram(
      finalValues.map((v) => ((v - startingCapital) / startingCapital) * 100),
      [-50, -40, -30, -20, -10, -5, 0, 5, 10, 20, 30, 40, 50, 100],
    ),
  };
}

function roundUsd(value) {
  return Math.round(value * 100) / 100;
}

function sanitizeResults(results) {
  return {
    ...results,
    p5FinalValueUsd: roundUsd(results.p5FinalValueUsd),
    p25FinalValueUsd: roundUsd(results.p25FinalValueUsd),
    p50FinalValueUsd: roundUsd(results.p50FinalValueUsd),
    p75FinalValueUsd: roundUsd(results.p75FinalValueUsd),
    p95FinalValueUsd: roundUsd(results.p95FinalValueUsd),
    meanFinalValueUsd: roundUsd(results.meanFinalValueUsd),
    probabilityOfRuin20Pct: roundUsd(results.probabilityOfRuin20Pct),
    probabilityOfRuin50Pct: roundUsd(results.probabilityOfRuin50Pct),
    equityCurves: (results.equityCurves ?? []).map((curve) => curve.map(roundUsd)),
  };
}

async function loadPaperClosingTrades(userId, strategyId) {
  const snap = await getDb()
    .collection(`users/${userId}/strategies/${strategyId}/trades`)
    .orderBy('executedAt', 'desc')
    .limit(200)
    .get();

  return snap.docs
    .map((doc) => doc.data())
    .filter((trade) => trade.isClosingTrade === true && trade.mode === 'paper');
}

async function runMonteCarloHandler(userId, data = {}) {
  const {
    strategyId,
    startingCapitalUsd = 1000,
    periodDays = 90,
  } = data;

  if (!strategyId || typeof strategyId !== 'string') {
    throw new HttpsError('invalid-argument', 'strategyId is required');
  }
  if (startingCapitalUsd <= 0) {
    throw new HttpsError('invalid-argument', 'startingCapitalUsd must be positive');
  }
  if (![30, 90, 180].includes(Number(periodDays))) {
    throw new HttpsError('invalid-argument', 'periodDays must be 30, 90, or 180');
  }

  const strategyRef = getDb().doc(`users/${userId}/strategies/${strategyId}`);
  const strategySnap = await strategyRef.get();
  if (!strategySnap.exists) {
    throw new HttpsError('not-found', 'Strategy not found');
  }

  await enforceRateLimit(userId, 'monte_carlo');

  const tradeData = await loadPaperClosingTrades(userId, strategyId);
  const params = tradeData.length >= 20
    ? deriveParamsFromTrades(tradeData)
    : {
      winRate: 0.5,
      avgWinPct: 0.03,
      avgLossPct: -0.02,
      stdDevWinPct: 0.02,
      stdDevLossPct: 0.01,
      tradesPerPeriod: 10,
    };

  const results = sanitizeResults(runSimulations({
    startingCapital: startingCapitalUsd,
    periodDays,
    simulationCount: 1000,
    ...params,
  }));

  const resultId = `${Date.now()}_${nanoid(6)}`;
  const payload = {
    resultId,
    strategyId,
    userId,
    startingCapitalUsd,
    simulationPeriodDays: periodDays,
    simulationCount: 1000,
    ...params,
    results,
    generatedAt: FieldValue.serverTimestamp(),
    dataSource: tradeData.length >= 20 ? 'paper_trades' : 'manual_params',
    tradesUsedForParams: tradeData.length,
    expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };

  try {
    await getDb()
      .doc(`users/${userId}/strategies/${strategyId}/monteCarloResults/${resultId}`)
      .set(payload);
  } catch (err) {
    logErrorLog(createLogContext('monteCarlo', userId, strategyId), 'Failed to persist Monte Carlo result', err);
  }

  return {
    resultId,
    results,
    params,
    dataSource: payload.dataSource,
    tradesUsedForParams: tradeData.length,
  };
}

async function runMonteCarloCallable(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  try {
    return await runMonteCarloHandler(userId, request.data ?? {});
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logErrorLog(createLogContext('monteCarlo', userId), 'Monte Carlo failed', err, {
      strategyId: request.data?.strategyId,
    });
    throw new HttpsError('internal', err.message || 'Monte Carlo simulation failed');
  }
}

module.exports = {
  deriveParamsFromTrades,
  runSimulations,
  runMonteCarloHandler,
  runMonteCarloCallable,
};
