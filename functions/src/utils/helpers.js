const { nanoid } = require('nanoid');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateCycleId() {
  return `${Date.now()}_${nanoid(6)}`;
}

function generateTradeId() {
  return `${Date.now()}_${nanoid(6)}`;
}

function generateErrorId() {
  return `${Date.now()}_${nanoid(8)}`;
}

function detectAssetClass(symbol, broker) {
  if (broker === 'binance') return 'crypto';
  if (symbol.endsWith('ETF') || ['SPY', 'QQQ', 'IWM', 'VTI'].includes(symbol)) return 'etf';
  return 'stock';
}

function isWithinActiveHours(strategy, now = new Date()) {
  const schedule = strategy.schedule || {};
  const activeHours = schedule.activeHours || {};

  if (!activeHours.enabled) return true;

  const daysOfWeek = activeHours.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
  const tz = activeHours.timezone || 'UTC';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (!daysOfWeek.includes(dayIndex)) return false;

  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const current = `${hour}:${minute}`;
  const start = activeHours.start || '00:00';
  const end = activeHours.end || '23:59';

  if (start <= end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function checkDrawdown(portfolioSnapshot, strategy) {
  const peak = strategy.stats?.peakPortfolioValueUsd ?? portfolioSnapshot.totalValueUsd;
  const current = portfolioSnapshot.totalValueUsd;
  const currentDrawdownPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;
  const limitPct = strategy.risk?.maxDrawdownPct ?? 100;

  return {
    peakValueUsd: peak,
    currentValueUsd: current,
    currentDrawdownPct,
    limitPct,
    breached: currentDrawdownPct >= limitPct,
  };
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatVolume(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
}

function gaussianRandom() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

function buildHistogram(values, buckets) {
  const counts = new Array(buckets.length).fill(0);
  for (const v of values) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (v >= buckets[i]) {
        counts[i]++;
        break;
      }
    }
  }
  return { buckets, counts };
}

function computeAnnualisedSharpe(returns) {
  if (!returns.length) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return (mean / std) * Math.sqrt(252);
}

function computeAnnualisedSortino(returns) {
  if (!returns.length) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (!downside.length) return null;
  const downsideVar = downside.reduce((s, r) => s + r ** 2, 0) / downside.length;
  const downsideStd = Math.sqrt(downsideVar);
  if (downsideStd === 0) return null;
  return (mean / downsideStd) * Math.sqrt(252);
}

module.exports = {
  sleep,
  generateCycleId,
  generateTradeId,
  generateErrorId,
  detectAssetClass,
  isWithinActiveHours,
  checkDrawdown,
  formatDuration,
  formatVolume,
  slugify,
  gaussianRandom,
  buildHistogram,
  computeAnnualisedSharpe,
  computeAnnualisedSortino,
  nanoid,
};
