/** Public crypto market data with cloud-safe fallbacks when Binance geo-blocks GCP. */

const BINANCE_PUBLIC_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api-gcp.binance.com',
  'https://api.binance.com',
];

const { normalizeWatchlistSymbol } = require('./symbolNormalize');

function parseUsdtSymbol(symbol) {
  const pair = normalizeWatchlistSymbol(symbol, 'binance');
  return { pair, base: pair.replace(/USDT$/, '') };
}

function parseIntervalMinutes(interval) {
  const match = /^(\d+)(m|h|d)$/.exec(interval);
  if (!match) throw new Error(`Unsupported interval: ${interval}`);
  const value = parseInt(match[1], 10);
  if (match[2] === 'm') return value;
  if (match[2] === 'h') return value * 60;
  return value * 24 * 60;
}

function toCandleRow(t, o, h, l, c, v) {
  return { t, o, h, l, c, v };
}

async function fetchJson(url, timeoutMs = 10000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (text.toLowerCase().includes('restricted location')) {
    throw new Error('Binance market data blocked from cloud region');
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(text);
}

async function fetchBinancePublicJson(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const suffix = query ? `${path}?${query}` : path;
  let lastError = null;

  for (const baseUrl of BINANCE_PUBLIC_ENDPOINTS) {
    try {
      return await fetchJson(`${baseUrl}${suffix}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('All Binance market data endpoints failed');
}

async function fetchBybitOHLCV(symbol, interval, limit) {
  const { pair } = parseUsdtSymbol(symbol);
  const intervalMap = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
  const bybitInterval = intervalMap[interval] ?? String(parseIntervalMinutes(interval));

  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${bybitInterval}&limit=${limit}`;
  const json = await fetchJson(url);
  if (json.retCode !== 0 || !json.result?.list?.length) {
    throw new Error(json.retMsg || 'Bybit klines empty');
  }

  return json.result.list
    .slice()
    .reverse()
    .map((row) => toCandleRow(
      parseInt(row[0], 10),
      parseFloat(row[1]),
      parseFloat(row[2]),
      parseFloat(row[3]),
      parseFloat(row[4]),
      parseFloat(row[5]),
    ));
}

async function fetchBybitSpotPrice(symbol) {
  const { pair } = parseUsdtSymbol(symbol);
  const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`;
  const json = await fetchJson(url, 5000);
  const price = json.result?.list?.[0]?.lastPrice;
  if (!price) throw new Error('Bybit price empty');
  return parseFloat(price);
}

async function fetchCryptoCompareOHLCV(symbol, interval, limit) {
  const { base } = parseUsdtSymbol(symbol);
  const aggregate = parseIntervalMinutes(interval);
  const url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${base}&tsym=USDT&limit=${limit}&aggregate=${aggregate}`;
  const json = await fetchJson(url);
  if (json.Response !== 'Success' || !json.Data?.Data?.length) {
    throw new Error(json.Message || 'CryptoCompare klines empty');
  }

  return json.Data.Data.map((row) => toCandleRow(
    row.time * 1000,
    row.open,
    row.high,
    row.low,
    row.close,
    row.volumefrom,
  ));
}

async function fetchCryptoCompareSpotPrice(symbol) {
  const { base } = parseUsdtSymbol(symbol);
  const url = `https://min-api.cryptocompare.com/data/price?fsym=${base}&tsyms=USDT`;
  const json = await fetchJson(url, 5000);
  const price = json.USDT;
  if (!price) throw new Error('CryptoCompare price empty');
  return parseFloat(price);
}

async function fetchPublicOHLCV(symbol, interval = '15m', limit = 200) {
  const providers = [
    {
      name: 'binance',
      fetch: async () => {
        const data = await fetchBinancePublicJson('/api/v3/klines', { symbol, interval, limit });
        return data.map((c) => toCandleRow(
          c[0],
          parseFloat(c[1]),
          parseFloat(c[2]),
          parseFloat(c[3]),
          parseFloat(c[4]),
          parseFloat(c[5]),
        ));
      },
    },
    { name: 'bybit', fetch: () => fetchBybitOHLCV(symbol, interval, limit) },
    { name: 'cryptocompare', fetch: () => fetchCryptoCompareOHLCV(symbol, interval, limit) },
  ];

  let lastError = null;
  for (const provider of providers) {
    try {
      const candles = await provider.fetch();
      if (!candles.length) throw new Error('empty candles');
      candles._source = provider.name;
      return candles;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('All public market data providers failed');
}

async function fetchPublicSpotPrice(symbol) {
  const providers = [
    {
      name: 'binance',
      fetch: async () => {
        const data = await fetchBinancePublicJson('/api/v3/ticker/price', { symbol });
        return parseFloat(data.price);
      },
    },
    { name: 'bybit', fetch: () => fetchBybitSpotPrice(symbol) },
    { name: 'cryptocompare', fetch: () => fetchCryptoCompareSpotPrice(symbol) },
  ];

  let lastError = null;
  for (const provider of providers) {
    try {
      return await provider.fetch();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('All public spot price providers failed');
}

async function pingPublicMarketData() {
  try {
    await fetchBinancePublicJson('/api/v3/ping');
    return true;
  } catch {
    try {
      await fetchBybitSpotPrice('BTCUSDT');
      return true;
    } catch {
      return false;
    }
  }
}

async function probePublicMarketData(symbol = 'BTCUSDT') {
  const results = {};
  for (const provider of ['binance', 'bybit', 'cryptocompare']) {
    const start = Date.now();
    try {
      if (provider === 'binance') {
        await fetchBinancePublicJson('/api/v3/klines', { symbol, interval: '15m', limit: 1 });
      } else if (provider === 'bybit') {
        await fetchBybitOHLCV(symbol, '15m', 1);
      } else {
        await fetchCryptoCompareOHLCV(symbol, '15m', 1);
      }
      results[provider] = { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      results[provider] = { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }
  return results;
}

module.exports = {
  fetchPublicOHLCV,
  fetchPublicSpotPrice,
  pingPublicMarketData,
  probePublicMarketData,
};
