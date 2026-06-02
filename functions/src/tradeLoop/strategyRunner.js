const { getDb, FieldValue } = require('../utils/db');
const { generateCycleId, generateTradeId, detectAssetClass, checkDrawdown } = require('../utils/helpers');
const { checkIdempotencyKey, writeIdempotencyKey } = require('../utils/idempotency');
const { pingBroker, fetchPortfolio, getBrokerAdapter } = require('../brokers/adapter');
const { getClaudeDecision, fallbackRuleEvaluation } = require('../claude/decision');
const { fetchMarketData, enrichWithExternalData } = require('./marketData');
const { validateDecision } = require('./validation');
const { updatePositionAfterTrade } = require('../positions/fifo');
const {
  applyRealizedPnlToStrategy,
  portfolioDrawdownUpdates,
} = require('../strategy/statsSync');
const { sendNotification } = require('../notifications/fcm');
const { logError } = require('../monitoring/errors');
const { incrementSystemMetric } = require('../monitoring/metrics');
const { createLogContext, logWarn, logErrorLog } = require('../monitoring/logger');
const { runShadowCycles } = require('../features/shadowMode');
const { enqueuePostMortemIfNeeded } = require('../features/postMortem');
const { commitSignalBaselines } = require('../features/signalBaselines');

async function autoPauseStrategy(strategy, userId, reason) {
  await getDb().doc(`users/${userId}/strategies/${strategy.strategyId}`).update({
    status: 'auto_paused',
    autoPausedAt: FieldValue.serverTimestamp(),
    autoPausedReason: reason,
    statusHistory: FieldValue.arrayUnion({
      status: 'auto_paused',
      changedAt: new Date(),
      reason,
    }),
  });
}

async function handleBrokerFailure(strategy, userId, err) {
  const ref = getDb().doc(`users/${userId}/strategies/${strategy.strategyId}`);
  const doc = await ref.get();
  const failures = (doc.data()?.brokerHealth?.consecutiveFailures ?? 0) + 1;

  const updates = {
    'brokerHealth.consecutiveFailures': failures,
    'brokerHealth.lastSuccessfulCycleAt': doc.data()?.brokerHealth?.lastSuccessfulCycleAt ?? null,
  };

  if (failures >= 3) {
    updates['brokerHealth.brokerUnreachable'] = true;
    updates['brokerHealth.brokerUnreachableAt'] = FieldValue.serverTimestamp();
  }

  await ref.update(updates);

  await logError({
    source: `broker_${strategy.assets.broker}`,
    severity: failures >= 3 ? 'critical' : 'error',
    userId,
    strategyId: strategy.strategyId,
    message: err.message,
    metadata: { consecutiveFailures: failures },
  });
}

async function incrementBrokerFailureCount(strategy, userId) {
  await handleBrokerFailure(strategy, userId, new Error('Cycle failed'));
}

async function skipCycle(cycleRef, reason, extra = {}) {
  await cycleRef.update({
    completedAt: FieldValue.serverTimestamp(),
    skippedReason: reason,
    decision: { action: 'skip', reasoning: extra.errorMessage ?? reason },
    ...extra,
    error: false,
  });
  return {
    cycleId: extra.cycleId,
    strategyId: extra.strategyId,
    tradeExecuted: false,
    error: false,
    skipped: true,
    skippedReason: reason,
    errorMessage: extra.errorMessage ?? null,
  };
}

async function completeCycle(cycleRef, data) {
  const durationMs = data.phases
    ? Object.values(data.phases).reduce((s, v) => s + (v ?? 0), 0)
    : null;

  await cycleRef.update({
    completedAt: FieldValue.serverTimestamp(),
    durationMs,
    portfolioSnapshot: data.portfolioSnapshot ?? null,
    drawdownCheck: data.drawdownCheck ?? null,
    marketSnapshot: data.marketSnapshot ?? null,
    claudeCalled: data.claudeResult?.claudeCalled ?? false,
    claudeMode: data.claudeResult?.claudeMode ?? null,
    claudeModel: data.claudeResult?.claudeModel ?? null,
    claudePromptTokens: data.claudeResult?.promptTokens ?? null,
    claudeCompletionTokens: data.claudeResult?.completionTokens ?? null,
    claudeCostUsd: data.claudeResult?.costUsd ?? null,
    claudeLatencyMs: data.claudeResult?.latencyMs ?? null,
    claudeRawResponse: data.claudeResult?.claudeRawResponse ?? null,
    claudeParseSuccess: data.claudeResult?.claudeParseSuccess ?? null,
    claudeParseError: data.claudeResult?.claudeParseError ?? null,
    rulesEvaluated: data.claudeResult?.rulesEvaluated ?? null,
    rulesTriggered: data.claudeResult?.rulesTriggered ?? data.decision?.rulesTriggered ?? null,
    decision: {
      ...data.decision,
      validationApplied: (data.validationNotes?.length ?? 0) > 0,
      validationNotes: data.validationNotes ?? null,
    },
    tradeExecuted: data.tradeExecuted ?? false,
    tradeId: data.tradeId ?? null,
    skippedReason: data.skippedReason ?? null,
    stopLossChecks: data.stopLossChecks ?? [],
    takeProfitChecks: data.takeProfitChecks ?? [],
    phases: data.phases ?? {},
    error: false,
    expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });

  return true;
}

async function recordAssetSuggestion(strategy, userId, decision) {
  await getDb().doc(`users/${userId}/strategies/${strategy.strategyId}`).update({
    'assets.claudeSuggested': FieldValue.arrayUnion({
      symbol: decision.suggestedAsset,
      reason: decision.suggestedAssetReasoning ?? decision.reasoning,
      suggestedAt: new Date(),
      accepted: null,
      acceptedAt: null,
    }),
  });
}

async function updateStrategyStats(strategy, userId, portfolioSnapshot, claudeResult, tradeResult) {
  const ref = getDb().doc(`users/${userId}/strategies/${strategy.strategyId}`);
  const updates = {
    lastCycleAt: FieldValue.serverTimestamp(),
    'stats.totalCycles': FieldValue.increment(1),
    'brokerHealth.lastSuccessfulCycleAt': FieldValue.serverTimestamp(),
    'brokerHealth.consecutiveFailures': 0,
    'brokerHealth.brokerUnreachable': false,
  };

  if (tradeResult) {
    updates.lastTradeAt = FieldValue.serverTimestamp();
    updates.lastTradeId = tradeResult.tradeId;
    updates['stats.totalTrades'] = FieldValue.increment(1);
    updates['stats.totalCyclesWithTrade'] = FieldValue.increment(1);
    if (strategy.mode === 'live') {
      updates['stats.totalLiveTrades'] = FieldValue.increment(1);
    } else {
      updates['stats.totalPaperTrades'] = FieldValue.increment(1);
    }
  }

  if (claudeResult?.costUsd) {
    updates['stats.claudeApiCalls'] = FieldValue.increment(1);
    updates['stats.claudeApiCostUsd'] = FieldValue.increment(claudeResult.costUsd);
  }

  const peak = Math.max(strategy.stats?.peakPortfolioValueUsd ?? 0, portfolioSnapshot.totalValueUsd);
  Object.assign(updates, portfolioDrawdownUpdates(strategy, portfolioSnapshot, peak));

  await ref.update(updates);

  if (tradeResult?.realizedPnlUsd != null) {
    await applyRealizedPnlToStrategy(ref, tradeResult.realizedPnlUsd);
  }
}

async function executeOrSimulate(strategy, decision, userId, cycleId, claudeResult, source = 'strategy') {
  const tradeId = generateTradeId();
  const tradeRef = getDb().doc(
    `users/${userId}/strategies/${strategy.strategyId}/trades/${tradeId}`,
  );

  const baseTradeDoc = {
    tradeId,
    strategyId: strategy.strategyId,
    userId,
    cycleId,
    broker: strategy.assets.broker,
    symbol: decision.symbol,
    assetClass: detectAssetClass(decision.symbol, strategy.assets.broker),
    side: decision.side,
    mode: strategy.mode,
    source,
    orderType: 'market',
    requestedNotionalUsd: decision.notionalUsd,
    claudeReasoning: decision.reasoning ?? '',
    claudeConfidence: decision.confidence ?? null,
    claudeMode: strategy.decisionMode,
    rulesTriggered: decision.rulesTriggered ?? null,
    requestedAt: FieldValue.serverTimestamp(),
    postMortem: { generated: false },
  };

  if (strategy.mode === 'paper') {
    const adapter = getBrokerAdapter(strategy.assets.broker, userId, true);
    const currentPrice = await adapter.getSpotPrice(decision.symbol).catch(() => {
      throw new Error(`Could not get price for ${decision.symbol}`);
    });
    const qty = decision.notionalUsd / currentPrice;

    const tradeDoc = {
      ...baseTradeDoc,
      executedQuantity: qty,
      executedPriceUsd: currentPrice,
      executedNotionalUsd: decision.notionalUsd,
      slippageUsd: 0,
      feeUsd: 0,
      feeCurrency: 'USD',
      feeAsset: null,
      brokerOrderId: null,
      brokerStatus: 'simulated',
      isOpeningTrade: decision.side === 'buy',
      isClosingTrade: decision.side === 'sell',
      openingTradeIds: [],
      realizedPnlUsd: null,
      realizedPnlPct: null,
      submittedAt: FieldValue.serverTimestamp(),
      executedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };

    await tradeRef.set(tradeDoc);
    await updatePositionAfterTrade(strategy, userId, decision, qty, currentPrice, tradeId);

    const updatedTrade = (await tradeRef.get()).data();
    await enqueuePostMortemIfNeeded(updatedTrade, strategy, userId);

    return {
      tradeId,
      mode: 'paper',
      executedPriceUsd: currentPrice,
      executedQuantity: qty,
      side: decision.side,
      symbol: decision.symbol,
      executedNotionalUsd: decision.notionalUsd,
      realizedPnlUsd: updatedTrade?.realizedPnlUsd ?? null,
    };
  }

  const broker = getBrokerAdapter(strategy.assets.broker, userId, false, {
    userId,
    strategyId: strategy.strategyId,
  });

  let brokerResult;
  try {
    const orderParams = {
      symbol: decision.symbol,
      side: decision.side,
      notionalUsd: decision.notionalUsd,
    };
    if (decision.side === 'sell') {
      const pos = (await fetchPortfolio(strategy, userId)).positions.find((p) => p.symbol === decision.symbol);
      if (pos) orderParams.quantity = pos.quantity;
    }
    brokerResult = await broker.placeOrder(orderParams);
  } catch (err) {
    await tradeRef.set({
      ...baseTradeDoc,
      brokerStatus: 'rejected',
      brokerRawResponse: err.message,
      executedQuantity: 0,
      executedPriceUsd: 0,
      executedNotionalUsd: 0,
      feeUsd: 0,
      feeCurrency: 'USD',
      submittedAt: FieldValue.serverTimestamp(),
      executedAt: FieldValue.serverTimestamp(),
    });

    await logError({
      source: `broker_${strategy.assets.broker}`,
      severity: 'error',
      userId,
      strategyId: strategy.strategyId,
      cycleId,
      message: `Order placement failed: ${err.message}`,
    });
    throw err;
  }

  const tradeDoc = {
    ...baseTradeDoc,
    executedQuantity: brokerResult.executedQty,
    executedPriceUsd: brokerResult.executedPrice,
    executedNotionalUsd: brokerResult.executedNotionalUsd,
    slippageUsd: 0,
    feeUsd: brokerResult.feeUsd,
    feeCurrency: brokerResult.feeCurrency,
    feeAsset: brokerResult.feeAsset,
    brokerOrderId: brokerResult.orderId,
    brokerStatus: brokerResult.status,
    brokerRawResponse: JSON.stringify(brokerResult.raw ?? {}),
    isOpeningTrade: decision.side === 'buy',
    isClosingTrade: decision.side === 'sell',
    openingTradeIds: [],
    fillConfirmedAt: brokerResult.status === 'filled' ? FieldValue.serverTimestamp() : null,
    submittedAt: FieldValue.serverTimestamp(),
    executedAt: brokerResult.status === 'filled' ? FieldValue.serverTimestamp() : null,
  };

  await tradeRef.set(tradeDoc);

  if (strategy.assets.broker === 'ibkr' && brokerResult.status !== 'filled') {
    await getDb().collection('ibkrPendingFills').add({
      userId,
      strategyId: strategy.strategyId,
      tradeId,
      brokerOrderId: brokerResult.orderId,
      symbol: decision.symbol,
      side: decision.side,
      submittedAt: FieldValue.serverTimestamp(),
      lastCheckedAt: null,
      checkCount: 0,
      status: 'pending',
      expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  } else {
    await updatePositionAfterTrade(
      strategy, userId, decision,
      brokerResult.executedQty, brokerResult.executedPrice, tradeId,
    );
    const updatedTrade = (await tradeRef.get()).data();
    await enqueuePostMortemIfNeeded(updatedTrade, strategy, userId);
  }

  await incrementSystemMetric('tradesToday', 1);
  await incrementSystemMetric('liveTradesToday', 1);
  await incrementSystemMetric('notionalVolumeUsdToday', brokerResult.executedNotionalUsd ?? 0);

  const updatedTrade = (await tradeRef.get()).data();
  return {
    tradeId,
    mode: 'live',
    executedPriceUsd: brokerResult.executedPrice,
    executedQuantity: brokerResult.executedQty,
    executedNotionalUsd: brokerResult.executedNotionalUsd,
    side: decision.side,
    symbol: decision.symbol,
    realizedPnlUsd: updatedTrade?.realizedPnlUsd ?? null,
  };
}

async function checkStopLossAndTakeProfit(strategy, userId, portfolio, cycleId) {
  const stopChecks = [];
  const takeProfitChecks = [];

  if (!strategy.risk?.stopLossPerTradePct && !strategy.risk?.takeProfitPerTradePct) {
    return { stopChecks, takeProfitChecks };
  }

  for (const position of portfolio.positions.filter((p) => p.quantity > 0)) {
    const pnlPct = position.unrealizedPnlPct ?? 0;

    if (strategy.risk.stopLossPerTradePct) {
      const triggered = pnlPct <= -Math.abs(strategy.risk.stopLossPerTradePct);
      let tradeId = null;

      if (triggered) {
        const result = await executeOrSimulate(strategy, {
          action: 'sell',
          side: 'sell',
          symbol: position.symbol,
          notionalUsd: position.currentValueUsd,
          reasoning: `Stop-loss triggered at ${pnlPct.toFixed(2)}%`,
          confidence: null,
          rulesTriggered: null,
        }, userId, cycleId, null, 'stop_loss');
        tradeId = result.tradeId;
        await sendNotification(userId, 'stop_loss_triggered', strategy, { symbol: position.symbol, pnlPct });
      }

      stopChecks.push({
        symbol: position.symbol,
        currentPnlPct: pnlPct,
        stopLossPct: strategy.risk.stopLossPerTradePct,
        triggered,
        tradeId,
      });
    }

    if (strategy.risk.takeProfitPerTradePct) {
      const triggered = pnlPct >= Math.abs(strategy.risk.takeProfitPerTradePct);
      let tradeId = null;

      if (triggered) {
        const result = await executeOrSimulate(strategy, {
          action: 'sell',
          side: 'sell',
          symbol: position.symbol,
          notionalUsd: position.currentValueUsd,
          reasoning: `Take-profit triggered at ${pnlPct.toFixed(2)}%`,
          confidence: null,
          rulesTriggered: null,
        }, userId, cycleId, null, 'take_profit');
        tradeId = result.tradeId;
      }

      takeProfitChecks.push({
        symbol: position.symbol,
        currentPnlPct: pnlPct,
        takeProfitPct: strategy.risk.takeProfitPerTradePct,
        triggered,
        tradeId,
      });
    }
  }

  return { stopChecks, takeProfitChecks };
}

async function runStrategyLoop(strategy, triggeredBy, runId, options = {}) {
  const { userId, strategyId } = strategy;
  const cycleId = generateCycleId();
  const cycleRef = getDb().doc(`users/${userId}/strategies/${strategyId}/cycles/${cycleId}`);
  const phases = {};
  let phaseStart = Date.now();
  const ctx = createLogContext('tradeLoop', userId, strategyId);

  if (options.skipExecution) {
    return previewStrategyDecision(strategy, userId);
  }

  await cycleRef.set({
    cycleId,
    strategyId,
    userId,
    triggeredBy,
    runId: runId ?? null,
    priceEventId: options.priceEventId ?? null,
    startedAt: FieldValue.serverTimestamp(),
    completedAt: null,
    error: false,
    tradeExecuted: false,
    decision: { action: 'pending' },
    expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });

  await incrementSystemMetric('cyclesToday', 1);

  try {
    if (strategy.brokerHealth?.brokerUnreachable) {
      const brokerOk = await pingBroker(strategy.assets.broker, userId, strategy.mode === 'paper');
      if (!brokerOk) {
        return skipCycle(cycleRef, 'broker_unreachable', { cycleId, strategyId });
      }
      await getDb().doc(`users/${userId}/strategies/${strategyId}`).update({
        'brokerHealth.brokerUnreachable': false,
        'brokerHealth.consecutiveFailures': 0,
      });
    }

    phaseStart = Date.now();
    let portfolioSnapshot;
    let marketSnapshot;
    let claudeResult;
    const previewContext = options.previewByStrategyId?.[strategyId];

    if (previewContext) {
      portfolioSnapshot = previewContext.portfolioSnapshot;
      marketSnapshot = previewContext.marketSnapshot;
      claudeResult = previewContext.claudeResult;
      phases.portfolioMs = 0;
      phases.marketDataMs = 0;
      phases.externalDataMs = 0;
      phases.claudeMs = 0;
    } else {
      try {
        portfolioSnapshot = await fetchPortfolio(strategy, userId);
      } catch (err) {
        await handleBrokerFailure(strategy, userId, err);
        return skipCycle(cycleRef, 'broker_portfolio_fetch_failed', { cycleId, strategyId, errorMessage: err.message });
      }
      phases.portfolioMs = Date.now() - phaseStart;

      phaseStart = Date.now();
      try {
        marketSnapshot = await fetchMarketData(strategy, userId);
      } catch (err) {
        await handleBrokerFailure(strategy, userId, err);
        return skipCycle(cycleRef, 'market_data_fetch_failed', { cycleId, strategyId, errorMessage: err.message });
      }

      if (marketSnapshot.dataStale) {
        logWarn(ctx, `Market data stale (${marketSnapshot.dataFreshnessMs}ms)`);
        return skipCycle(cycleRef, 'market_data_stale', { cycleId, strategyId, marketSnapshot, portfolioSnapshot });
      }
      phases.marketDataMs = Date.now() - phaseStart;

      phaseStart = Date.now();
      marketSnapshot = await enrichWithExternalData(marketSnapshot, strategy);
      phases.externalDataMs = Date.now() - phaseStart;

      phaseStart = Date.now();
      const upcomingEvents = marketSnapshot.macroEvents ?? [];
      try {
        claudeResult = await getClaudeDecision(strategy, portfolioSnapshot, marketSnapshot, upcomingEvents);
      } catch (err) {
        if (strategy.decisionMode === 'rule_interpreter') {
          claudeResult = await fallbackRuleEvaluation(strategy, marketSnapshot, portfolioSnapshot);
        } else {
          await logError({
            source: 'claude_api',
            severity: 'error',
            userId,
            strategyId,
            cycleId,
            message: err.message,
            stack: err.stack,
          });
          return skipCycle(cycleRef, 'claude_api_failed', {
            cycleId, strategyId, marketSnapshot, portfolioSnapshot, errorMessage: err.message,
          });
        }
      }
      phases.claudeMs = Date.now() - phaseStart;
    }

    phaseStart = Date.now();
    const drawdownResult = checkDrawdown(portfolioSnapshot, strategy);
    if (drawdownResult.breached) {
      await autoPauseStrategy(strategy, userId, 'max_drawdown_exceeded');
      await sendNotification(userId, 'drawdown_limit_hit', strategy, drawdownResult);
      await completeCycle(cycleRef, {
        portfolioSnapshot,
        drawdownCheck: drawdownResult,
        decision: {
          action: 'skip',
          reasoning: `Auto-paused: drawdown ${drawdownResult.currentDrawdownPct.toFixed(1)}% exceeded limit ${drawdownResult.limitPct}%`,
        },
        phases,
      });
      return { cycleId, strategyId, tradeExecuted: false, error: false };
    }
    phases.drawdownMs = Date.now() - phaseStart;

    phaseStart = Date.now();
    const stopChecks = await checkStopLossAndTakeProfit(strategy, userId, portfolioSnapshot, cycleId);
    phases.stopCheckMs = Date.now() - phaseStart;

    phaseStart = Date.now();
    const { decision, validationNotes } = validateDecision(
      claudeResult.decision,
      strategy,
      portfolioSnapshot,
      marketSnapshot,
    );
    phases.validationMs = Date.now() - phaseStart;

    phaseStart = Date.now();
    let tradeResult = null;
    let skippedReason = null;

    if (decision.action === 'buy' || decision.action === 'sell') {
      const idempotencyKey = `${strategyId}_${cycleId}_${decision.side}_${decision.symbol}`;

      if (await checkIdempotencyKey(idempotencyKey)) {
        logWarn(ctx, 'Idempotency key exists — skipping duplicate order');
        skippedReason = 'duplicate_prevented_by_idempotency';
      } else {
        await writeIdempotencyKey(idempotencyKey, { userId, strategyId, cycleId, side: decision.side, symbol: decision.symbol });
        tradeResult = await executeOrSimulate(strategy, decision, userId, cycleId, claudeResult);
      }
    } else if (decision.action === 'suggest_asset') {
      await recordAssetSuggestion(strategy, userId, decision);
      const notif = strategy.notifications?.useDefaults !== false
        ? true
        : strategy.notifications?.onAssetSuggestion;
      if (notif) {
        await sendNotification(userId, 'asset_suggested', strategy, decision);
      }
    }
    phases.executionMs = Date.now() - phaseStart;

    phaseStart = Date.now();
    await updateStrategyStats(strategy, userId, portfolioSnapshot, claudeResult, tradeResult);
    phases.statsMs = Date.now() - phaseStart;

    const notifSettings = strategy.notifications ?? {};
    if (tradeResult && (notifSettings.onTrade || notifSettings.useDefaults !== false)) {
      await sendNotification(userId, 'trade_executed', strategy, tradeResult);
    }
    if (notifSettings.onCycle) {
      await sendNotification(userId, 'cycle_complete', strategy, decision);
    }
    if (decision.flagForReview) {
      await sendNotification(userId, 'strategy_flagged_for_review', strategy, decision);
    }

    await completeCycle(cycleRef, {
      portfolioSnapshot,
      drawdownCheck: drawdownResult,
      marketSnapshot,
      claudeResult,
      decision,
      validationNotes,
      tradeExecuted: tradeResult !== null,
      tradeId: tradeResult?.tradeId ?? null,
      skippedReason,
      stopLossChecks: stopChecks.stopChecks,
      takeProfitChecks: stopChecks.takeProfitChecks,
      phases,
    });

    await commitSignalBaselines(strategy, userId, marketSnapshot.crossMarket);

    getDb()
      .collection(`users/${userId}/strategies/${strategyId}/shadowConfigs`)
      .where('status', '==', 'active')
      .get()
      .then((snap) => {
        if (snap.size > 0) {
          runShadowCycles(
            strategy,
            portfolioSnapshot,
            marketSnapshot,
            cycleId,
            snap.docs.map((d) => d.data()),
          ).catch((err) => logError({
            source: 'shadow_mode',
            severity: 'warning',
            userId,
            strategyId,
            message: err.message,
          }));
        }
      })
      .catch(() => {});

    await getDb().doc('systemMetrics/current').set({
      lastCycleAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { cycleId, strategyId, tradeExecuted: tradeResult !== null, error: false, decision,
      ...(claudeResult?.claudeParseSuccess === false ? {
        claudeParseError: claudeResult.claudeParseError ?? null,
      } : {}),
    };
  } catch (err) {
    logErrorLog(ctx, `Unexpected cycle error: ${err.message}`, err);

    await logError({
      source: 'trade_loop',
      severity: 'error',
      userId,
      strategyId,
      cycleId,
      message: err.message,
      stack: err.stack,
      metadata: { triggeredBy, runId },
    });

    await cycleRef.update({
      completedAt: FieldValue.serverTimestamp(),
      error: true,
      errorSource: 'unknown',
      errorMessage: err.message,
      'decision.action': 'error',
    });

    await incrementBrokerFailureCount(strategy, userId);
    return { cycleId, strategyId, tradeExecuted: false, error: true };
  }
}

async function previewStrategyDecision(strategy, userId) {
  try {
    const portfolioSnapshot = await fetchPortfolio(strategy, userId);
    let marketSnapshot = await fetchMarketData(strategy, userId);
    if (marketSnapshot.dataStale) {
      return {
        strategy,
        preview: { action: 'hold', reasoning: 'Market data stale', confidence: null },
      };
    }
    marketSnapshot = await enrichWithExternalData(marketSnapshot, strategy);
    const claudeResult = await getClaudeDecision(
      strategy,
      portfolioSnapshot,
      marketSnapshot,
      marketSnapshot.macroEvents ?? [],
    );
    const { decision } = validateDecision(claudeResult.decision, strategy, portfolioSnapshot, marketSnapshot);
    return {
      strategy,
      preview: decision,
      portfolioSnapshot,
      marketSnapshot,
      claudeResult,
    };
  } catch {
    return { strategy, preview: { action: 'hold', reasoning: 'Preview unavailable', confidence: 0 } };
  }
}

module.exports = {
  runStrategyLoop,
  previewStrategyDecision,
  executeOrSimulate,
  autoPauseStrategy,
  handleBrokerFailure,
  updateStrategyStats,
};
