const { getDb, FieldValue } = require('../utils/db');
const { fetchYahooChart } = require('./crossMarketContext');

function pctChange(from, to) {
  if (from == null || from === 0 || to == null) return null;
  return ((to - from) / from) * 100;
}

function getSignalState(strategy, signalId) {
  const nested = strategy.signalState?.signals?.[signalId];
  if (nested) return nested;
  if (signalId === 'dxy' && strategy.signalState?.dxy) return strategy.signalState.dxy;
  return {};
}

function applyBaselineMetrics(strategy, signalConfig, currentPrice, existingNode = {}) {
  const prev = getSignalState(strategy, signalConfig.id);
  const baselinePrice = prev.baselinePrice ?? null;
  const changeSinceBaselinePct = baselinePrice != null
    ? pctChange(baselinePrice, currentPrice)
    : null;
  const changeSinceBaselineAbsPct = changeSinceBaselinePct != null
    ? Math.abs(changeSinceBaselinePct)
    : null;
  const thresholdPct = signalConfig.thresholdPct
    ?? strategy.signalState?.[`${signalConfig.id}ThresholdPct`]
    ?? null;
  const meetsMoveThreshold = thresholdPct != null
    && changeSinceBaselineAbsPct != null
    && changeSinceBaselineAbsPct >= thresholdPct;

  return {
    ...existingNode,
    price: currentPrice,
    baselinePrice,
    baselineAt: prev.baselineAt ?? null,
    changeSinceBaselinePct,
    changeSinceBaselineAbsPct,
    moveThresholdPct: thresholdPct,
    meetsMoveThreshold,
    isFirstBaseline: baselinePrice == null,
  };
}

async function fetchSignalPrice(signalConfig) {
  if (signalConfig.source === 'yahoo') {
    const chart = await fetchYahooChart(signalConfig.symbol, '1h', '1d');
    return chart.price;
  }
  throw new Error(`Unsupported signal source: ${signalConfig.source}`);
}

async function enrichMarketWithSignalBaselines(strategy, crossMarket) {
  const configs = strategy.signals ?? [];
  if (!crossMarket || !configs.length) return crossMarket;

  let result = {
    ...crossMarket,
    computedSignals: { ...(crossMarket.computedSignals ?? {}) },
  };

  for (const cfg of configs) {
    const marketKey = cfg.marketKey ?? cfg.id;
    let currentPrice = result[marketKey]?.price ?? null;

    if (cfg.freshFetch !== false) {
      try {
        currentPrice = await fetchSignalPrice(cfg);
      } catch {
        // Keep cached cross-market price when live fetch fails.
      }
    }

    if (currentPrice == null) continue;

    const enriched = applyBaselineMetrics(
      strategy,
      cfg,
      currentPrice,
      result[marketKey] ?? {},
    );
    result[marketKey] = enriched;

    result.computedSignals[`${cfg.id}ChangeSinceBaselinePct`] = enriched.changeSinceBaselinePct;
    result.computedSignals[`${cfg.id}ChangeSinceBaselineAbsPct`] = enriched.changeSinceBaselineAbsPct;
    result.computedSignals[`${cfg.id}MeetsMoveThreshold`] = enriched.meetsMoveThreshold;
    result.computedSignals[`${cfg.id}IsFirstBaseline`] = enriched.isFirstBaseline;
  }

  return result;
}

async function commitSignalBaselines(strategy, userId, crossMarket) {
  const configs = strategy.signals ?? [];
  if (!configs.length || !crossMarket) return;

  const signals = { ...(strategy.signalState?.signals ?? {}) };

  for (const cfg of configs) {
    const marketKey = cfg.marketKey ?? cfg.id;
    const price = crossMarket[marketKey]?.price;
    if (price == null) continue;

    signals[cfg.id] = {
      baselinePrice: price,
      baselineAt: FieldValue.serverTimestamp(),
      lastReadPrice: price,
      lastReadAt: FieldValue.serverTimestamp(),
    };
  }

  await getDb().doc(`users/${userId}/strategies/${strategy.strategyId}`).set({
    signalState: { signals },
  }, { merge: true });
}

function formatSignalBaselinesBlock(crossMarket, signals = []) {
  if (!crossMarket || !signals.length) return '';

  const lines = ['Signal baselines (vs previous cycle):'];
  for (const cfg of signals) {
    const marketKey = cfg.marketKey ?? cfg.id;
    const node = crossMarket[marketKey];
    if (!node?.price) continue;

    const label = cfg.label ?? cfg.id.toUpperCase();
    if (node.isFirstBaseline || node.baselinePrice == null) {
      lines.push(`- ${label}: first read $${Number(node.price).toFixed(4)}`);
      continue;
    }

    const delta = node.changeSinceBaselinePct;
    const deltaStr = delta == null ? 'n/a' : `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}%`;
    const threshold = node.moveThresholdPct != null ? ` ±${node.moveThresholdPct}%` : '';
    lines.push(
      `- ${label}: $${Number(node.baselinePrice).toFixed(4)} → $${Number(node.price).toFixed(4)} (${deltaStr}${threshold})`,
    );
  }

  return lines.length > 1 ? `\n${lines.join('\n')}\n` : '';
}

function getSignalMetrics(crossMarket, signalConfig) {
  const marketKey = signalConfig.marketKey ?? signalConfig.id;
  return crossMarket?.[marketKey] ?? null;
}

function scaleNotionalByBaselineSteps(rule, strategy, market, baseNotional) {
  const wantsScale = rule.scaleByBaselineSteps === true
    || /SCALE_STEPS/i.test(rule.action ?? '');
  if (!wantsScale || !baseNotional) return baseNotional;

  const configs = strategy.signals ?? [];
  for (const cfg of configs) {
    const idUpper = cfg.id.toUpperCase();
    const cond = rule.condition ?? '';
    if (!cond.includes(`${idUpper}_CHANGE_SINCE_BASELINE`)
      && !cond.includes('DXY_CHANGE_SINCE_BASELINE')) {
      continue;
    }

    const metrics = getSignalMetrics(market.crossMarket, cfg);
    const thresholdPct = cfg.thresholdPct ?? metrics?.moveThresholdPct;
    if (!metrics?.changeSinceBaselineAbsPct || !thresholdPct) return baseNotional;

    const steps = Math.floor(metrics.changeSinceBaselineAbsPct / thresholdPct);
    if (steps < 1) return 0;

    const maxCap = cfg.maxStepNotionalUsd
      ?? strategy.risk?.maxNotionalUsd
      ?? strategy.risk?.maxPositionSizeUsd
      ?? 500;

    return Math.min(baseNotional * steps, maxCap);
  }

  return baseNotional;
}

module.exports = {
  enrichMarketWithSignalBaselines,
  commitSignalBaselines,
  formatSignalBaselinesBlock,
  getSignalMetrics,
  scaleNotionalByBaselineSteps,
  applyBaselineMetrics,
};
