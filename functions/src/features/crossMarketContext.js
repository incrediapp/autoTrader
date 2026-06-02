const { getDb, FieldValue } = require('../utils/db');
const { fetchPublicOHLCV } = require('../brokers/publicMarketData');

const CACHE_DOC = 'externalDataCache/crossMarket';
const CACHE_TTL_MS = 30 * 60 * 1000;

async function fetchYahooChart(symbol, interval, range) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=${interval}&range=${range}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoTrader/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Yahoo chart HTTP ${response.status} for ${symbol}`);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart empty for ${symbol}`);

  const quote = result.indicators?.quote?.[0];
  const timestamps = result.timestamp ?? [];
  const candles = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const open = quote?.open?.[i];
    const high = quote?.high?.[i];
    const low = quote?.low?.[i];
    const close = quote?.close?.[i];
    if (open == null || close == null) continue;
    candles.push({
      t: timestamps[i] * 1000,
      o: open,
      h: high ?? open,
      l: low ?? open,
      c: close,
    });
  }

  if (!candles.length) throw new Error(`Yahoo chart has no valid candles for ${symbol}`);

  return {
    symbol: result.meta?.symbol ?? symbol,
    price: result.meta?.regularMarketPrice ?? candles.at(-1).c,
    candles,
  };
}

function pctChange(from, to) {
  if (!from) return null;
  return ((to - from) / from) * 100;
}

function buildSeriesMetrics(label, symbol, candles, source) {
  const latest = candles.at(-1);
  const prev1h = candles.length >= 2 ? candles.at(-2) : latest;
  const prev24h = candles.length >= 25 ? candles.at(-25) : candles[0];
  const prev5d = candles[0];

  const changePct1h = pctChange(prev1h.c, latest.c);
  const changePct24h = pctChange(prev24h.c, latest.c);
  const changePct5d = pctChange(prev5d.c, latest.c);

  return {
    label,
    symbol,
    source,
    price: latest.c,
    changePct1h,
    changePct24h,
    changePct5d,
    isGreen1h: latest.c >= latest.o,
    isUp1h: changePct1h != null ? changePct1h > 0 : null,
    isUp24h: changePct24h != null ? changePct24h > 0 : null,
    isDownOver3Pct24h: changePct24h != null ? changePct24h <= -3 : null,
    isDownOver3Pct5d: changePct5d != null ? changePct5d <= -3 : null,
    candleCount: candles.length,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchBitcoinMetrics() {
  const candles = await fetchPublicOHLCV('BTCUSDT', '1h', 120);
  const metrics = buildSeriesMetrics('Bitcoin (BTCUSDT spot proxy)', 'BTCUSDT', candles, 'binance');
  metrics.note = 'Spot BTCUSDT used as futures proxy on Binance paper mode';
  return metrics;
}

async function fetchCrossMarketContext() {
  try {
    const cacheRef = getDb().doc(CACHE_DOC);
    const cached = await cacheRef.get();
    if (cached.exists) {
      const data = cached.data();
      const ageMs = Date.now() - (data.fetchedAt?.toMillis?.() ?? 0);
      if (ageMs < CACHE_TTL_MS) return data.payload;
    }
  } catch {
    // Cache unavailable — fetch fresh data.
  }

  const partial = {};
  const errors = [];

  try {
    const nasdaq = await fetchYahooChart('QQQ', '1h', '5d');
    partial.nasdaq = buildSeriesMetrics('Nasdaq 100 (QQQ proxy)', nasdaq.symbol, nasdaq.candles, 'yahoo');
  } catch (err) {
    errors.push({ series: 'nasdaq', error: err.message });
  }

  try {
    const dxy = await fetchYahooChart('DX-Y.NYB', '1h', '5d');
    partial.dxy = buildSeriesMetrics('US Dollar Index (DXY)', dxy.symbol, dxy.candles, 'yahoo');
  } catch (err) {
    errors.push({ series: 'dxy', error: err.message });
  }

  try {
    partial.bitcoin = await fetchBitcoinMetrics();
  } catch (err) {
    errors.push({ series: 'bitcoin', error: err.message });
  }

  const signals = [];
  if (partial.nasdaq?.isGreen1h) signals.push('nasdaq_1h_green');
  if (partial.bitcoin?.isUp1h) signals.push('bitcoin_1h_up');
  if (partial.bitcoin?.isUp24h) signals.push('bitcoin_24h_up');
  if (partial.dxy?.isDownOver3Pct5d) signals.push('dxy_down_over_3pct_5d');
  if (partial.dxy?.isDownOver3Pct24h) signals.push('dxy_down_over_3pct_24h');

  const coreBullish = [
    partial.nasdaq?.isGreen1h === true,
    partial.bitcoin?.isUp1h === true,
    partial.dxy?.isDownOver3Pct5d === true || partial.dxy?.isDownOver3Pct24h === true,
  ];
  const bullishConditionCount = coreBullish.filter(Boolean).length;

  const payload = {
    ...partial,
    computedSignals: {
      nasdaq1hGreen: partial.nasdaq?.isGreen1h ?? null,
      bitcoin1hUp: partial.bitcoin?.isUp1h ?? null,
      bitcoin24hUp: partial.bitcoin?.isUp24h ?? null,
      dxyDownOver3Pct24h: partial.dxy?.isDownOver3Pct24h ?? null,
      dxyDownOver3Pct5d: partial.dxy?.isDownOver3Pct5d ?? null,
      bullishConditionCount,
      bullishConditionsMet: bullishConditionCount >= 2,
      activeSignals: signals,
    },
    errors: errors.length ? errors : null,
    fetchedAt: new Date().toISOString(),
  };

  try {
    await getDb().doc(CACHE_DOC).set({
      payload,
      fetchedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  } catch {
    // Ignore cache write failures.
  }

  return payload;
}

function formatCrossMarketBlock(crossMarket) {
  if (!crossMarket) return '';

  const lines = ['Cross-market context:'];

  for (const key of ['nasdaq', 'dxy', 'bitcoin']) {
    const s = crossMarket[key];
    if (!s) continue;
    lines.push(
      `- ${s.label}: $${Number(s.price).toFixed(2)} | 1h: ${formatPct(s.changePct1h)} (${s.isGreen1h ?? s.isUp1h ? 'green/up' : 'red/down'}) | 24h: ${formatPct(s.changePct24h)} | 5d: ${formatPct(s.changePct5d)}`,
    );
  }

  const cs = crossMarket.computedSignals;
  if (cs) {
    lines.push(
      `- Strategy signals: ${cs.bullishConditionCount}/3 bullish checks met (Nasdaq 1h green, Bitcoin 1h up, DXY down >3%)`,
    );
    if (cs.activeSignals?.length) {
      lines.push(`- Active: ${cs.activeSignals.join(', ')}`);
    }
  }

  if (crossMarket.errors?.length) {
    lines.push(`- Partial data errors: ${crossMarket.errors.map((e) => `${e.series}: ${e.error}`).join('; ')}`);
  }

  return `\n${lines.join('\n')}\n`;
}

function formatPct(value) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

module.exports = {
  fetchCrossMarketContext,
  formatCrossMarketBlock,
  fetchYahooChart,
};
