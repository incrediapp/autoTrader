const { fetchPaperPortfolioFromFirestore } = require('./paperPortfolio');
const { getDb, FieldValue } = require('../utils/db');
const { logBrokerCall } = require('../monitoring/logger');
const { incrementSystemMetric } = require('../monitoring/metrics');
const { ibkrApiRequest, pingIbkrCredentials } = require('./ibkrSession');

async function ibkrRequest(method, path, userId, body = null, ctx = {}) {
  const start = Date.now();
  let success = false;
  let errorCode = null;

  try {
    const data = await ibkrApiRequest(method, path, body);
    success = true;
    return data;
  } catch (err) {
    errorCode = err.message?.slice(0, 32) ?? 'error';
    throw err;
  } finally {
    logBrokerCall(ctx, {
      broker: 'ibkr',
      endpoint: path,
      method,
      success,
      durationMs: Date.now() - start,
      errorCode,
    });
    await incrementSystemMetric('ibkrApiCallsToday', 1);
    if (!success) await incrementSystemMetric('ibkrApiErrorsToday', 1);
  }
}

async function getIBKRAccountId(userId) {
  const userDoc = await getDb().doc(`users/${userId}`).get();
  const accountId = userDoc.data()?.brokers?.ibkr?.accountId;
  if (accountId) return accountId;

  const accounts = await ibkrRequest('GET', '/portfolio/accounts', userId);
  const id = accounts?.[0]?.id ?? accounts?.[0]?.accountId;
  if (id) {
    await getDb().doc(`users/${userId}`).update({ 'brokers.ibkr.accountId': id });
  }
  return id;
}

async function resolveConid(symbol, userId) {
  const cached = await getDb().doc(`ibkrConidCache/${symbol}`).get();
  if (cached.exists) return cached.data().conid;

  const results = await ibkrRequest('GET', `/iserver/secdef/search?symbol=${symbol}&secType=STK`, userId);
  if (!results?.length) throw new Error(`IBKR: No contract found for symbol ${symbol}`);

  const contract = results.find((r) => r.currency === 'USD') ?? results[0];

  await getDb().doc(`ibkrConidCache/${symbol}`).set({
    symbol,
    conid: contract.conid,
    exchange: contract.exchange,
    currency: contract.currency,
    secType: contract.secType ?? 'STK',
    cachedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  return contract.conid;
}

async function fetchIBKRPortfolio(userId, ctx = {}) {
  const accountId = await getIBKRAccountId(userId);
  if (!accountId) {
    return { fetchedAt: new Date(), broker: 'ibkr', totalValueUsd: 0, cashUsd: 0, positions: [] };
  }

  const positions = await ibkrRequest('GET', `/portfolio/${accountId}/positions/0`, userId, null, ctx);
  const summary = await ibkrRequest('GET', `/portfolio/${accountId}/summary`, userId, null, ctx);

  const cashUsd = parseFloat(summary?.availablefunds?.amount ?? summary?.totalcashvalue?.amount ?? 0);

  const mappedPositions = (positions ?? []).map((p) => ({
    symbol: p.ticker ?? p.contractDesc,
    quantity: p.position,
    avgCostUsd: p.avgCost ?? p.avgPrice ?? 0,
    currentPriceUsd: p.mktPrice ?? 0,
    currentValueUsd: p.mktValue ?? 0,
    unrealizedPnlUsd: p.unrealizedPnl ?? 0,
    unrealizedPnlPct: p.unrealizedPnlPercent ?? 0,
    openingTradeId: null,
  }));

  const totalValueUsd = cashUsd + mappedPositions.reduce((s, p) => s + p.currentValueUsd, 0);

  return {
    fetchedAt: new Date(),
    broker: 'ibkr',
    totalValueUsd,
    cashUsd,
    positions: mappedPositions,
  };
}

async function fetchIBKROHLCV(symbol, userId) {
  const conid = await resolveConid(symbol, userId);
  const data = await ibkrRequest(
    'GET',
    `/iserver/marketdata/history?conid=${conid}&period=2d&bar=15min&outsideRth=false`,
    userId,
  );

  if (!data?.data?.length) throw new Error(`IBKR: No historical data for ${symbol}`);

  return data.data.map((c) => ({
    t: c.t * 1000,
    o: c.o,
    h: c.h,
    l: c.l,
    c: c.c,
    v: c.v,
  }));
}

async function getIBKRSpotPrice(conid, userId) {
  const data = await ibkrRequest('GET', `/iserver/marketdata/snapshot?conids=${conid}&fields=31`, userId);
  const price = data?.[0]?.['31'] ?? data?.[0]?.lastPrice;
  return parseFloat(price) || 0;
}

async function placeIBKROrder({ symbol, side, notionalUsd, quantity }, userId, ctx = {}) {
  const accountId = await getIBKRAccountId(userId);
  const conid = await resolveConid(symbol, userId);

  if (!quantity) {
    const price = await getIBKRSpotPrice(conid, userId);
    quantity = Math.floor((notionalUsd / price) * 100) / 100;
    if (quantity <= 0) throw new Error(`Calculated quantity too small: ${quantity}`);
  }

  const orderBody = {
    orders: [{
      conid,
      orderType: 'MKT',
      side: side.toUpperCase(),
      quantity,
      tif: 'DAY',
      outsideRth: false,
    }],
  };

  let result = await ibkrRequest('POST', `/iserver/account/${accountId}/orders`, userId, orderBody, ctx);

  if (result[0]?.id && result[0]?.message) {
    result = await ibkrRequest('POST', `/iserver/reply/${result[0].id}`, userId, { confirmed: true }, ctx);
  }

  const order = result[0];
  if (!order?.order_id) {
    throw new Error(`IBKR order placement failed: ${JSON.stringify(result)}`);
  }

  return {
    orderId: order.order_id.toString(),
    status: order.order_status === 'Filled' ? 'filled' : 'pending_fill',
    executedQty: order.order_status === 'Filled' ? order.filledQuantity : quantity,
    executedPrice: order.avgPrice ?? 0,
    executedNotionalUsd: (order.avgPrice ?? 0) * quantity,
    feeUsd: 0,
    feeCurrency: 'USD',
    feeAsset: null,
    raw: order,
  };
}

async function getIBKROrderStatus(userId, orderId) {
  const accountId = await getIBKRAccountId(userId);
  const data = await ibkrRequest('GET', `/iserver/account/${accountId}/order/status/${orderId}`, userId);

  return {
    status: data.status,
    filledQuantity: data.filled ?? 0,
    remainingQuantity: data.remaining ?? 0,
    avgPrice: data.avgPrice ?? 0,
    commission: data.commission ?? 0,
    lastFillTime: data.lastFillTime ?? null,
  };
}

class IBKRAdapter {
  constructor(userId, isPaper = false, ctx = {}) {
    this.userId = userId;
    this.isPaper = isPaper;
    this.ctx = ctx;
  }

  async ping() {
    try {
      await pingIbkrCredentials();
      return true;
    } catch {
      return false;
    }
  }

  async fetchPortfolio() {
    if (this.isPaper) {
      const strategy = this.ctx.strategy ?? {
        strategyId: this.ctx.strategyId,
        stats: {},
      };
      return fetchPaperPortfolioFromFirestore(
        strategy,
        this.userId,
        'ibkr',
        (symbol) => this.getSpotPrice(symbol),
      );
    }
    return fetchIBKRPortfolio(this.userId, this.ctx);
  }

  async fetchOHLCV(symbol) {
    return fetchIBKROHLCV(symbol, this.userId);
  }

  async getSpotPrice(symbol) {
    const conid = await resolveConid(symbol, this.userId);
    return getIBKRSpotPrice(conid, this.userId);
  }

  async placeOrder(opts) {
    return placeIBKROrder(opts, this.userId, this.ctx);
  }

  async getOrderStatus(orderId) {
    return getIBKROrderStatus(this.userId, orderId);
  }

  async getAllPositions() {
    const portfolio = await this.fetchPortfolio();
    return portfolio.positions;
  }
}

module.exports = {
  IBKRAdapter,
  resolveConid,
  fetchIBKRPortfolio,
  fetchIBKROHLCV,
  placeIBKROrder,
  getIBKROrderStatus,
  getIBKRAccountId,
  pingIbkrCredentials,
};
