const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');

require('./src/utils/db');

const { tradeLoopScheduled } = require('./src/tradeLoop/scheduled');
const { tradeLoopOnPriceEvent } = require('./src/tradeLoop/eventDriven');
const { priceMonitor } = require('./src/tradeLoop/priceMonitor');
const {
  computeDailyStats,
  ibkrFillPoller,
  sendDailySummaries,
  cleanupExpiredData,
  refreshEarningsCalendar,
  refreshMacroCalendar,
} = require('./src/admin/stats');
const { postMortemProcessor } = require('./src/features/postMortem');
const { autopilotAnalysis } = require('./src/features/autopilot');

const {
  strategySetupHandler,
  strategyReinterpretHandler,
  createStrategyHandler,
  createUserProfileHandler,
  completeOnboardingHandler,
} = require('./src/strategy/setup');

const {
  applyAutopilotProposalsHandler,
  triggerAutopilotAnalysisHandler,
} = require('./src/features/autopilot');

const { generateReplaySessionHandler } = require('./src/features/replay');
const { runMonteCarloCallable } = require('./src/features/monteCarlo');
const { resolveConflictHandler } = require('./src/features/conflicts');

const {
  adminSuspendUserHandler,
  adminPromoteUserHandler,
  adminResolveErrorHandler,
} = require('./src/admin/adminActions');

const { getDb, FieldValue } = require('./src/utils/db');
const { getSecret, storeSecret, deleteSecret } = require('./src/utils/secrets');
const { withAppSecrets } = require('./src/config/secrets');
const { enforceRateLimit } = require('./src/utils/rateLimit');
const { checkIdempotencyKey, writeIdempotencyKey } = require('./src/utils/idempotency');
const { sanitiseErrorForClient } = require('./src/utils/sanitise');
const { nanoid } = require('./src/utils/helpers');
const { getBrokerAdapter } = require('./src/brokers/adapter');
const { testBinanceCredentials, isGeoBlockError } = require('./src/brokers/binance');
const { sendNotification } = require('./src/notifications/fcm');

const callableDefaults = withAppSecrets({
  region: 'us-central1',
  maxInstances: 10,
});

// ── Scheduled functions ──────────────────────────────────────────────────────
exports.tradeLoopScheduled = tradeLoopScheduled;
exports.priceMonitor = priceMonitor;
exports.ibkrFillPoller = ibkrFillPoller;
exports.computeDailyStats = computeDailyStats;
exports.sendDailySummaries = sendDailySummaries;
exports.cleanupExpiredData = cleanupExpiredData;
exports.autopilotAnalysis = autopilotAnalysis;
exports.refreshEarningsCalendar = refreshEarningsCalendar;
exports.refreshMacroCalendar = refreshMacroCalendar;

// ── Firestore triggers ───────────────────────────────────────────────────────
exports.tradeLoopOnPriceEvent = tradeLoopOnPriceEvent;
exports.postMortemProcessor = postMortemProcessor;

// ── Strategy setup callables ─────────────────────────────────────────────────
exports.strategySetup = onCall({ ...callableDefaults, timeoutSeconds: 120, memory: '512MiB' }, strategySetupHandler);
exports.strategyReinterpret = onCall({ ...callableDefaults, timeoutSeconds: 120, memory: '512MiB' }, strategyReinterpretHandler);
exports.createStrategy = onCall(callableDefaults, createStrategyHandler);
exports.createUserProfile = onCall(callableDefaults, createUserProfileHandler);
exports.completeOnboarding = onCall(callableDefaults, completeOnboardingHandler);

// ── Broker callables ─────────────────────────────────────────────────────────
exports.connectBroker = onCall({ ...callableDefaults, timeoutSeconds: 60 }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'connect_broker');

  const { broker, apiKey, apiSecret, accountId, label } = request.data ?? {};
  if (!broker) throw new HttpsError('invalid-argument', 'broker required');

  if (broker === 'binance') {
    if (!apiKey || !apiSecret) throw new HttpsError('invalid-argument', 'apiKey and apiSecret required');

    const useTestnet = request.data?.testnetEnabled !== false && request.data?.testnetEnabled !== 'false';
    let validationWarning = null;

    try {
      await testBinanceCredentials(apiKey, apiSecret, useTestnet);
    } catch (err) {
      if (isGeoBlockError(err)) {
        validationWarning = 'Connected without server verification — Binance blocked our cloud region, not your account.';
      } else {
        throw new HttpsError('invalid-argument', `API key validation failed: ${sanitiseErrorForClient(err.message)}`);
      }
    }

    const prefix = useTestnet ? 'binance_testnet' : 'binance';
    await storeSecret(`${prefix}_apikey_${userId}`, apiKey);
    await storeSecret(`${prefix}_apisecret_${userId}`, apiSecret);

    await getDb().doc(`users/${userId}`).set({
      brokers: {
        binance: {
          connected: true,
          connectedAt: FieldValue.serverTimestamp(),
          lastVerifiedAt: FieldValue.serverTimestamp(),
          label: label ?? null,
          testnetEnabled: useTestnet,
          validationSkipped: !!validationWarning,
          lastErrorAt: validationWarning ? FieldValue.serverTimestamp() : null,
          lastErrorMessage: validationWarning,
        },
      },
    }, { merge: true });

    return { connected: true, broker, validationWarning };
  } else if (broker === 'ibkr') {
    const { pingIbkrCredentials } = require('./src/brokers/ibkrSession');
    try {
      await pingIbkrCredentials();
    } catch (err) {
      throw new HttpsError(
        'failed-precondition',
        'IBKR credentials not configured on server. Add your OAuth keys to Secret Manager / .env.',
      );
    }

    await getDb().doc(`users/${userId}`).set({
      brokers: {
        ibkr: {
          connected: true,
          connectedAt: FieldValue.serverTimestamp(),
          lastVerifiedAt: FieldValue.serverTimestamp(),
          accountId: accountId ?? null,
          label: label ?? null,
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      },
    }, { merge: true });
  } else {
    throw new HttpsError('invalid-argument', `Unknown broker: ${broker}`);
  }

  return { connected: true, broker };
});

exports.verifyBrokerConnection = onCall({ timeoutSeconds: 60 }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'verify_broker');

  const { broker } = request.data ?? {};
  const user = (await getDb().doc(`users/${userId}`).get()).data();
  const isPaper = user?.brokers?.binance?.testnetEnabled ?? false;

  const adapter = getBrokerAdapter(broker, userId, isPaper);
  const ok = await adapter.ping();

  await getDb().doc(`users/${userId}`).update({
    [`brokers.${broker}.lastVerifiedAt`]: FieldValue.serverTimestamp(),
    [`brokers.${broker}.connected`]: ok,
  });

  return { ok, broker };
});

exports.disconnectBroker = onCall(callableDefaults, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'disconnect_broker');

  const { broker } = request.data ?? {};
  const secrets = broker === 'binance'
    ? [`binance_apikey_${userId}`, `binance_apisecret_${userId}`, `binance_testnet_apikey_${userId}`, `binance_testnet_apisecret_${userId}`]
    : [];

  await Promise.all(secrets.map((s) => deleteSecret(s).catch(() => {})));

  await getDb().doc(`users/${userId}`).update({
    [`brokers.${broker}.connected`]: false,
    [`brokers.${broker}.connectedAt`]: null,
  });

  return { disconnected: true, broker };
});

// ── Emergency & strategy control ─────────────────────────────────────────────
exports.emergencySellAll = onCall({ timeoutSeconds: 120, maxInstances: 10 }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  const rateLimitKey = `emergency_${userId}`;
  if (await checkIdempotencyKey(rateLimitKey)) {
    throw new HttpsError('resource-exhausted', 'Emergency sell already in progress');
  }
  await writeIdempotencyKey(rateLimitKey, { userId }, 60);

  const strategies = await getDb().collectionGroup('strategies')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .get();

  await Promise.all(strategies.docs.map((doc) => doc.ref.update({
    status: 'paused',
    pausedAt: FieldValue.serverTimestamp(),
    statusHistory: FieldValue.arrayUnion({ status: 'paused', changedAt: new Date(), reason: 'emergency_sell_all' }),
  })));

  const user = (await getDb().doc(`users/${userId}`).get()).data();
  const results = { sold: [], failed: [], total: 0 };
  const brokerSells = [];

  if (user.brokers?.binance?.connected) {
    const adapter = getBrokerAdapter('binance', userId, user.brokers.binance.testnetEnabled);
    const portfolio = await adapter.fetchPortfolio();
    for (const pos of portfolio.positions.filter((p) => p.quantity > 0)) {
      brokerSells.push({ broker: 'binance', symbol: pos.symbol, quantity: pos.quantity });
    }
  }

  if (user.brokers?.ibkr?.connected) {
    const adapter = getBrokerAdapter('ibkr', userId);
    const portfolio = await adapter.fetchPortfolio();
    for (const pos of portfolio.positions.filter((p) => p.quantity > 0)) {
      brokerSells.push({ broker: 'ibkr', symbol: pos.symbol, quantity: pos.quantity });
    }
  }

  results.total = brokerSells.length;

  const sellResults = await Promise.allSettled(
    brokerSells.map(async (pos) => {
      const broker = getBrokerAdapter(pos.broker, userId);
      const result = await broker.placeOrder({ symbol: pos.symbol, side: 'sell', quantity: pos.quantity });
      return { symbol: pos.symbol, broker: pos.broker, sold: true, orderId: result.orderId };
    }),
  );

  for (const r of sellResults) {
    if (r.status === 'fulfilled') results.sold.push(r.value);
    else results.failed.push({ error: r.reason?.message ?? 'Unknown error' });
  }

  await sendNotification(userId, 'emergency_sell_executed', null, results);
  return results;
});

exports.emergencySellStrategy = onCall({ timeoutSeconds: 120 }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'emergency_sell_strategy');

  const { strategyId } = request.data ?? {};
  const strat = await getDb().doc(`users/${userId}/strategies/${strategyId}`).get();
  if (!strat.exists) throw new HttpsError('not-found', 'Strategy not found');

  const strategy = strat.data();
  await strat.ref.update({
    status: 'paused',
    pausedAt: FieldValue.serverTimestamp(),
  });

  const adapter = getBrokerAdapter(strategy.assets.broker, userId, strategy.mode === 'paper');
  const portfolio = await adapter.fetchPortfolio();
  const sold = [];

  for (const pos of portfolio.positions.filter((p) => p.quantity > 0)) {
    try {
      await adapter.placeOrder({ symbol: pos.symbol, side: 'sell', quantity: pos.quantity });
      sold.push(pos.symbol);
    } catch {
      // continue with other positions
    }
  }

  return { strategyId, sold };
});

exports.toggleStrategyStatus = onCall(callableDefaults, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'toggle_strategy_status');

  const { strategyId, status } = request.data ?? {};
  if (!['active', 'paused', 'archived'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Invalid status');
  }

  const ref = getDb().doc(`users/${userId}/strategies/${strategyId}`);
  await ref.update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
    statusHistory: FieldValue.arrayUnion({ status, changedAt: new Date(), reason: 'user_toggle' }),
    ...(status === 'paused' ? { pausedAt: FieldValue.serverTimestamp() } : {}),
    ...(status === 'archived' ? { archivedAt: FieldValue.serverTimestamp() } : {}),
  });

  return { strategyId, status };
});

exports.switchStrategyMode = onCall(callableDefaults, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'switch_strategy_mode');

  const { strategyId, mode } = request.data ?? {};
  if (!['paper', 'live'].includes(mode)) {
    throw new HttpsError('invalid-argument', 'mode must be paper or live');
  }

  const ref = getDb().doc(`users/${userId}/strategies/${strategyId}`);
  const updates = {
    mode,
    updatedAt: FieldValue.serverTimestamp(),
    modeHistory: FieldValue.arrayUnion({ mode, changedAt: new Date(), changedByUserId: userId }),
  };
  if (mode === 'live') updates.liveEnabledAt = FieldValue.serverTimestamp();

  await ref.update(updates);
  return { strategyId, mode };
});

exports.manualCycleTrigger = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'manual_cycle');

  const { strategyId } = request.data ?? {};
  const strat = await getDb().doc(`users/${userId}/strategies/${strategyId}`).get();
  if (!strat.exists) throw new HttpsError('not-found', 'Strategy not found');

  const { runStrategyLoop } = require('./src/tradeLoop/strategyRunner');
  const result = await runStrategyLoop(strat.data(), 'manual', nanoid(8));
  return result;
});

// ── Analytics & exports ──────────────────────────────────────────────────────
exports.generateTradeExport = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'generate_trade_export');

  const { strategyId, startDate, endDate } = request.data ?? {};
  let query = getDb().collectionGroup('trades').where('userId', '==', userId);

  if (strategyId) query = getDb().collection(`users/${userId}/strategies/${strategyId}/trades`);

  if (startDate) {
    query = query.where('executedAt', '>=', new Date(startDate));
  }
  if (endDate) {
    query = query.where('executedAt', '<=', new Date(endDate));
  }

  const trades = await query.orderBy('executedAt', 'desc').limit(1000).get();

  const rows = trades.docs.map((d) => {
    const t = d.data();
    return {
      tradeId: t.tradeId,
      symbol: t.symbol,
      side: t.side,
      mode: t.mode,
      executedAt: t.executedAt?.toDate?.()?.toISOString?.() ?? null,
      executedNotionalUsd: t.executedNotionalUsd,
      realizedPnlUsd: t.realizedPnlUsd,
      feeUsd: t.feeUsd,
    };
  });

  return { trades: rows, count: rows.length, exportedAt: new Date().toISOString() };
});

exports.getAnalytics = onCall(callableDefaults, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'get_analytics');

  const { strategyId } = request.data ?? {};
  const user = (await getDb().doc(`users/${userId}`).get()).data();

  if (strategyId) {
    const strat = (await getDb().doc(`users/${userId}/strategies/${strategyId}`).get()).data();
    return { userId, strategyId, stats: strat?.stats ?? {} };
  }

  return { userId, stats: user?.stats ?? {} };
});

exports.updateFcmToken = onCall(callableDefaults, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'update_fcm_token');

  const { token, action = 'add' } = request.data ?? {};
  if (!token) throw new HttpsError('invalid-argument', 'token required');

  const userRef = getDb().doc(`users/${userId}`);

  if (action === 'remove') {
    const user = (await userRef.get()).data();
    const tokens = (user.notifications?.fcmTokens ?? []).filter((t) => t !== token);
    await userRef.update({ 'notifications.fcmTokens': tokens });
  } else {
    await userRef.set({
      notifications: {
        fcmTokens: FieldValue.arrayUnion(token),
        fcmTokensUpdatedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true });
  }

  return { ok: true };
});

// ── New feature callables ────────────────────────────────────────────────────
exports.applyAutopilotProposals = onCall(callableDefaults, applyAutopilotProposalsHandler);
exports.triggerAutopilotAnalysis = onCall(callableDefaults, triggerAutopilotAnalysisHandler);

exports.runMonteCarlo = onCall({ timeoutSeconds: 120, memory: '1GiB' }, runMonteCarloCallable);

exports.generateReplaySession = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'replay_session');

  const { strategyId, startDate, endDate } = request.data ?? {};
  if (!strategyId || !startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'strategyId, startDate, endDate required');
  }

  return generateReplaySessionHandler(userId, { strategyId, startDate, endDate });
});

exports.resolveConflict = onCall(callableDefaults, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'resolve_conflict');

  return resolveConflictHandler(userId, request.data);
});

// ── Admin callables ──────────────────────────────────────────────────────────
exports.adminSuspendUser = onCall(callableDefaults, adminSuspendUserHandler);
exports.adminPromoteUser = onCall(callableDefaults, adminPromoteUserHandler);
exports.adminResolveError = onCall(callableDefaults, adminResolveErrorHandler);

// ── Health check ─────────────────────────────────────────────────────────────
exports.healthCheck = onRequest(withAppSecrets({ timeoutSeconds: 10, maxInstances: 1 }), async (req, res) => {
  const checks = {};

  try {
    const start = Date.now();
    await getDb().doc('systemMetrics/current').get();
    checks.firestore = { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    checks.firestore = { ok: false, error: err.message };
  }

  try {
    const start = Date.now();
    await getSecret('anthropic_api_key');
    checks.secretManager = { ok: true, latencyMs: Date.now() - start };
  } catch {
    checks.secretManager = { ok: process.env.FUNCTIONS_EMULATOR === 'true', error: 'unavailable' };
  }

  try {
    const metrics = await getDb().doc('systemMetrics/current').get();
    const lastCycle = metrics.data()?.lastCycleAt?.toDate?.();
    const ageMs = lastCycle ? Date.now() - lastCycle.getTime() : null;
    checks.tradeLoop = {
      ok: process.env.FUNCTIONS_EMULATOR === 'true' || (ageMs !== null && ageMs < 20 * 60 * 1000),
      lastCycleAgeMs: ageMs,
      lastCycleAt: lastCycle?.toISOString() ?? null,
    };
  } catch (err) {
    checks.tradeLoop = { ok: false, error: err.message };
  }

  try {
    const { probePublicMarketData, fetchPublicOHLCV } = require('./src/brokers/publicMarketData');
    const { fetchCrossMarketContext } = require('./src/features/crossMarketContext');
    const probe = await probePublicMarketData('BTCUSDT');
    const candles = await fetchPublicOHLCV('BTCUSDT', '15m', 5);
    let crossMarket = null;
    try {
      crossMarket = await fetchCrossMarketContext();
    } catch (err) {
      crossMarket = { error: err.message };
    }
    checks.marketData = {
      ok: candles.length >= 5,
      source: candles._source ?? 'unknown',
      probe,
      crossMarket: crossMarket?.computedSignals ?? crossMarket,
    };
  } catch (err) {
    checks.marketData = { ok: false, error: err.message };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});
