const crypto = require('crypto');
const { getSecret } = require('../utils/secrets');
const { logBrokerCall } = require('../monitoring/logger');
const { incrementSystemMetric } = require('../monitoring/metrics');
const { sleep } = require('../utils/helpers');

const { fetchPaperPortfolioFromFirestore } = require('./paperPortfolio');

const BINANCE = {
  // GCP-routed endpoint avoids "restricted location" blocks from Cloud Functions.
  live: 'https://api-gcp.binance.com',
  paper: 'https://testnet.binance.vision',
};

const {
  fetchPublicOHLCV,
  fetchPublicSpotPrice,
  pingPublicMarketData,
} = require('./publicMarketData');

function mapBinanceError(data, status, isPaper = false) {
  const msg = data?.msg || `HTTP ${status}`;
  const code = data?.code;

  if (typeof msg === 'string' && msg.toLowerCase().includes('restricted location')) {
    if (isPaper) {
      return new Error(
        'Binance testnet blocked requests from our cloud server region (your keys may still be valid).',
      );
    }
    return new Error(
      'Binance blocked this region from our cloud servers. Use testnet keys with testnet mode, or api-gcp for live.',
    );
  }
  if (code === -2015) {
    return new Error(
      'Invalid API key, IP not whitelisted, or missing permissions. Use testnet keys for testnet mode, and disable IP restrictions on the key.',
    );
  }
  if (code === -1022) {
    return new Error('Invalid API secret (bad signature). Check you copied the secret correctly.');
  }
  if (code === -2014) {
    return new Error('Invalid API key format.');
  }
  return new Error(msg);
}

async function parseBinanceResponse(response, isPaper = false) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text.toLowerCase().includes('restricted location')) {
      if (isPaper) {
        throw new Error(
          'Binance testnet blocked requests from our cloud server region (your keys may still be valid).',
        );
      }
      throw new Error('Binance blocked this region from our cloud servers.');
    }
    throw new Error(`Binance HTTP ${response.status}`);
  }
}

function isGeoBlockError(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('restricted location')
    || msg.includes('blocked this region')
    || msg.includes('cloud server region');
}

async function getBinanceCredentials(userId, isPaper) {
  const prefix = isPaper ? 'binance_testnet' : 'binance';
  try {
    const apiKey = await getSecret(`${prefix}_apikey_${userId}`);
    const apiSecret = await getSecret(`${prefix}_apisecret_${userId}`);
    return { apiKey, apiSecret };
  } catch {
    return { apiKey: null, apiSecret: null };
  }
}

function createSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binanceRequest(method, path, params, userId, isPaper, ctx = {}) {
  const creds = await getBinanceCredentials(userId, isPaper);
  if (!creds.apiKey || !creds.apiSecret) {
    throw new Error('Binance credentials not configured');
  }

  const baseUrl = isPaper ? BINANCE.paper : BINANCE.live;
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryString = new URLSearchParams(
    Object.entries(allParams).map(([k, v]) => [k, String(v)]),
  ).toString();
  const signature = createSignature(queryString, creds.apiSecret);
  const url = `${baseUrl}${path}?${queryString}&signature=${signature}`;

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
      await sleep(retryAfter * 1000);
      return binanceRequest(method, path, params, userId, isPaper, ctx);
    }

    const data = await response.json();
    const success = response.ok && !(data.code && data.code < 0);

    logBrokerCall(ctx, {
      broker: 'binance',
      endpoint: path,
      method,
      success,
      durationMs: Date.now() - start,
      errorCode: data.code ?? null,
    });

    await incrementSystemMetric('binanceApiCallsToday', 1);
    if (!success) {
      await incrementSystemMetric('binanceApiErrorsToday', 1);
      throw new Error(data.msg || `Binance HTTP ${response.status}`);
    }

    return data;
  } catch (err) {
    clearTimeout(timeout);
    await incrementSystemMetric('binanceApiErrorsToday', 1);
    if (err.name === 'AbortError') throw new Error('Binance API timeout (10s)');
    throw err;
  }
}

async function testBinanceCredentials(apiKey, apiSecret, isPaper = false) {
  const baseUrl = isPaper ? BINANCE.paper : BINANCE.live;
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}&recvWindow=10000`;
  const signature = createSignature(queryString, apiSecret);
  const url = `${baseUrl}/api/v3/account?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: { 'X-MBX-APIKEY': apiKey },
    signal: AbortSignal.timeout(15000),
  });

  const data = await parseBinanceResponse(response, isPaper);
  if (!response.ok) {
    throw mapBinanceError(data, response.status, isPaper);
  }
  return true;
}

async function fetchBinanceOHLCV(symbol, interval = '15m', limit = 200, _isPaper = false) {
  return fetchPublicOHLCV(symbol, interval, limit);
}

async function getSpotPrice(symbol, _userId, _isPaper) {
  return fetchPublicSpotPrice(symbol);
}

async function fetchBinancePortfolio(userId, isPaper, ctx = {}) {
  try {
    const data = await binanceRequest('GET', '/api/v3/account', {}, userId, isPaper, ctx);
    const stablecoins = ['USDT', 'BUSD', 'USDC', 'FDUSD'];

    const nonZero = data.balances.filter(
      (b) => parseFloat(b.free) > 0.000001 || parseFloat(b.locked) > 0.000001,
    );

    const cashUsd = nonZero
      .filter((b) => stablecoins.includes(b.asset))
      .reduce((sum, b) => sum + parseFloat(b.free) + parseFloat(b.locked), 0);

    const positions = nonZero
      .filter((b) => !stablecoins.includes(b.asset))
      .map((b) => ({
        symbol: `${b.asset}USDT`,
        asset: b.asset,
        quantity: parseFloat(b.free) + parseFloat(b.locked),
      }));

    const prices = await Promise.all(
      positions.map((p) => getSpotPrice(p.symbol, userId, isPaper).catch(() => 0)),
    );

    const enrichedPositions = positions.map((p, i) => {
      const price = prices[i];
      const avgCostUsd = price;
      return {
        symbol: p.symbol,
        quantity: p.quantity,
        avgCostUsd,
        currentPriceUsd: price,
        currentValueUsd: p.quantity * price,
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        openingTradeId: null,
      };
    });

    const totalValueUsd = cashUsd + enrichedPositions.reduce((s, p) => s + p.currentValueUsd, 0);

    return {
      fetchedAt: new Date(),
      broker: 'binance',
      totalValueUsd,
      cashUsd,
      positions: enrichedPositions,
    };
  } catch (err) {
    if (isPaper) {
      const strategy = ctx.strategy ?? { strategyId: ctx.strategyId, stats: {} };
      return fetchPaperPortfolioFromFirestore(
        strategy,
        userId,
        'binance',
        (symbol) => getSpotPrice(symbol, userId, true),
      );
    }
    throw err;
  }
}

async function placeBinanceOrder({ symbol, side, notionalUsd, quantity }, userId, isPaper, ctx = {}) {
  const params = {
    symbol,
    side: side.toUpperCase(),
    type: 'MARKET',
    newOrderRespType: 'FULL',
  };

  if (side === 'buy') {
    params.quoteOrderQty = notionalUsd.toFixed(2);
  } else {
    if (!quantity) throw new Error('Sell order requires quantity');
    params.quantity = quantity.toFixed(8);
  }

  const result = await binanceRequest('POST', '/api/v3/order', params, userId, isPaper, ctx);
  const fills = result.fills ?? [];
  const totalFee = fills.reduce((sum, f) => sum + parseFloat(f.commission), 0);
  const executedQty = parseFloat(result.executedQty);
  const executedNotional = parseFloat(result.cummulativeQuoteQty);
  const avgPrice = executedQty > 0 ? executedNotional / executedQty : 0;

  return {
    orderId: result.orderId.toString(),
    status: result.status === 'FILLED' ? 'filled' : 'partial',
    executedQty,
    executedPrice: avgPrice,
    executedNotionalUsd: executedNotional,
    feeUsd: totalFee,
    feeCurrency: 'USD',
    feeAsset: fills[0]?.commissionAsset ?? 'USDT',
    raw: result,
  };
}

class BinanceAdapter {
  constructor(userId, isPaper = false, ctx = {}) {
    this.userId = userId;
    this.isPaper = isPaper;
    this.ctx = ctx;
  }

  async ping() {
    return pingPublicMarketData();
  }

  async fetchPortfolio() {
    return fetchBinancePortfolio(this.userId, this.isPaper, {
      ...this.ctx,
      strategyId: this.ctx.strategyId,
    });
  }

  async fetchOHLCV(symbol, interval = '15m', limit = 200) {
    return fetchBinanceOHLCV(symbol, interval, limit, this.isPaper);
  }

  async getSpotPrice(symbol) {
    return getSpotPrice(symbol, this.userId, this.isPaper);
  }

  async placeOrder(opts) {
    return placeBinanceOrder(opts, this.userId, this.isPaper, this.ctx);
  }

  async getOrderStatus(orderId) {
    const data = await binanceRequest(
      'GET',
      '/api/v3/order',
      { symbol: 'BTCUSDT', orderId },
      this.userId,
      this.isPaper,
      this.ctx,
    );
    return { status: data.status, filledQuantity: parseFloat(data.executedQty), avgPrice: 0 };
  }

  async getAllPositions() {
    const portfolio = await this.fetchPortfolio();
    return portfolio.positions;
  }
}

module.exports = {
  BinanceAdapter,
  testBinanceCredentials,
  isGeoBlockError,
  fetchBinanceOHLCV,
  getSpotPrice,
  fetchBinancePortfolio,
  placeBinanceOrder,
  BINANCE,
};
