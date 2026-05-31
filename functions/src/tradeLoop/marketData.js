const { getDb, FieldValue } = require('../utils/db');
const { fetchOHLCV } = require('../brokers/adapter');
const { normalizeWatchlist } = require('../brokers/symbolNormalize');
const { buildAssetSnapshot } = require('./indicators');
const { getSecret } = require('../utils/secrets');
const { getEarningsContext } = require('../features/earningsCalendar');
const { getUpcomingMacroEvents } = require('../features/macroCalendar');
const { fetchCrossMarketContext } = require('../features/crossMarketContext');

async function getMarketDataCache(cacheKey) {
  const doc = await getDb().doc(`marketDataCache/${cacheKey}`).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function setMarketDataCache(cacheKey, data) {
  await getDb().doc(`marketDataCache/${cacheKey}`).set({
    ...data,
    fetchedAt: FieldValue.serverTimestamp(),
    nextFetchAllowedAt: new Date(Date.now() + 14 * 60 * 1000),
    expireAt: new Date(Date.now() + 20 * 60 * 1000),
  });
}

const CANDLE_INTERVAL_MS = 15 * 60 * 1000;
/** Latest 15m candle open time may lag up to one full interval; allow 2 intervals + slack. */
const STALE_MS = (2 * CANDLE_INTERVAL_MS) + (5 * 60 * 1000);

async function fetchMarketData(strategy, userId) {
  const { watchlist, broker } = strategy.assets;
  const normalizedWatchlist = normalizeWatchlist(watchlist, broker);
  if (normalizedWatchlist.join(',') !== watchlist.join(',')) {
    await getDb().doc(`users/${userId}/strategies/${strategy.strategyId}`).update({
      'assets.watchlist': normalizedWatchlist,
      updatedAt: FieldValue.serverTimestamp(),
    });
    strategy.assets.watchlist = normalizedWatchlist;
  }

  const now = Date.now();
  const isPaper = strategy.mode === 'paper';
  const assetData = [];

  for (const symbol of normalizedWatchlist) {
    const cacheKey = `${symbol}_15m`;
    const cached = await getMarketDataCache(cacheKey);
    let candles;

    if (cached?.candles?.length && cached.fetchedAt?.toMillis) {
      const cacheAge = now - cached.fetchedAt.toMillis();
      const lastCandleAge = now - cached.candles[cached.candles.length - 1].t;
      if (cacheAge < 14 * 60 * 1000 && lastCandleAge < STALE_MS) {
        candles = cached.candles;
      }
    }

    if (!candles) {
      candles = await fetchOHLCV(broker, userId, symbol, '15m', 200, isPaper);
      await setMarketDataCache(cacheKey, { symbol, interval: '15m', broker, candles });
    }

    if (!candles || candles.length < 50) {
      throw new Error(`Insufficient candle data for ${symbol}: ${candles?.length ?? 0} candles`);
    }

    const snapshot = buildAssetSnapshot(symbol, candles, now);

    if (broker === 'ibkr') {
      snapshot.earningsContext = await getEarningsContext(symbol);
    }

    assetData.push(snapshot);
  }

  const newestFreshness = Math.max(...assetData.map((a) => a.dataFreshnessMs));

  return {
    fetchedAt: new Date(),
    dataFreshnessMs: newestFreshness,
    dataStale: newestFreshness > STALE_MS,
    assets: assetData,
    fearGreedIndex: null,
    fearGreedLabel: null,
    fearGreedCachedAt: null,
    newsHeadlines: null,
    newsFetchedAt: null,
    newsSkipped: false,
    newsSkipReason: null,
    macroEvents: [],
    crossMarket: null,
  };
}

async function fetchFearGreedCached() {
  const cacheRef = getDb().doc('externalDataCache/fearGreed');
  const cached = await cacheRef.get();

  if (cached.exists) {
    const data = cached.data();
    const ageMs = Date.now() - (data.fetchedAt?.toMillis?.() ?? 0);
    if (ageMs < 60 * 60 * 1000) return data;
  }

  const response = await fetch('https://api.alternative.me/fng/?limit=1', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Fear & Greed API failed: ${response.status}`);

  const json = await response.json();
  const entry = json.data[0];

  const result = {
    value: parseInt(entry.value, 10),
    label: entry.value_classification,
    fetchedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 60 * 60 * 1000),
  };

  await cacheRef.set(result);
  return result;
}

async function checkAndIncrementNewsQuota() {
  const quotaRef = getDb().doc('externalDataCache/newsdataQuota');

  return getDb().runTransaction(async (tx) => {
    const doc = await tx.get(quotaRef);
    const today = new Date().toISOString().split('T')[0];
    const data = doc.data() ?? { callsToday: 0, quotaLimit: 200, dayReset: today };

    if (data.dayReset !== today) {
      data.callsToday = 0;
      data.dayReset = today;
      data.quotaExhausted = false;
    }

    if (data.callsToday >= data.quotaLimit) {
      data.quotaExhausted = true;
      tx.set(quotaRef, data);
      return { ok: false };
    }

    data.callsToday += 1;
    data.lastCallAt = FieldValue.serverTimestamp();
    tx.set(quotaRef, data);
    return { ok: true };
  });
}

async function fetchNewsCached(symbols) {
  const symbolKey = symbols.map((s) => s.replace('USDT', '')).sort().join('_');
  const cacheRef = getDb().doc(`externalDataCache/news_${symbolKey}`);
  const cached = await cacheRef.get();

  if (cached.exists) {
    const ageMs = Date.now() - (cached.data().fetchedAt?.toMillis?.() ?? 0);
    if (ageMs < 30 * 60 * 1000) return cached.data().headlines;
  }

  const quota = await checkAndIncrementNewsQuota();
  if (!quota.ok) throw new Error('NEWS_QUOTA_EXHAUSTED');

  let apiKey;
  try {
    apiKey = await getSecret('newsdata_api_key');
  } catch {
    return [];
  }

  const query = symbols.map((s) => s.replace('USDT', '')).join(' OR ');
  const url = `https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(query)}&language=en&size=5`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });

  if (!response.ok) throw new Error(`Newsdata.io failed: ${response.status}`);

  const data = await response.json();
  const headlines = (data.results ?? []).slice(0, 3).map((r) => r.title);

  await cacheRef.set({
    headlines,
    symbolKey,
    fetchedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  return headlines;
}

async function enrichWithExternalData(marketSnapshot, strategy) {
  const enriched = { ...marketSnapshot };

  if (strategy.assets.broker === 'binance') {
    try {
      const fg = await fetchFearGreedCached();
      enriched.fearGreedIndex = fg.value;
      enriched.fearGreedLabel = fg.label;
      enriched.fearGreedCachedAt = fg.fetchedAt;
    } catch {
      // degrade gracefully
    }
  }

  try {
    const quotaOk = await checkAndIncrementNewsQuota();
    if (!quotaOk.ok) {
      enriched.newsSkipped = true;
      enriched.newsSkipReason = 'quota_exhausted';
    } else {
      enriched.newsHeadlines = await fetchNewsCached(strategy.assets.watchlist);
      enriched.newsFetchedAt = new Date();
    }
  } catch (err) {
    enriched.newsSkipped = true;
    enriched.newsSkipReason = err.message.includes('QUOTA') ? 'quota_exhausted' : 'api_error';
  }

  try {
    enriched.macroEvents = await getUpcomingMacroEvents(24);
  } catch {
    enriched.macroEvents = [];
  }

  try {
    enriched.crossMarket = await fetchCrossMarketContext();
  } catch {
    enriched.crossMarket = null;
  }

  return enriched;
}

module.exports = {
  fetchMarketData,
  enrichWithExternalData,
  getMarketDataCache,
  setMarketDataCache,
  fetchFearGreedCached,
  fetchNewsCached,
};
