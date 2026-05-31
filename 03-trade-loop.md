# Trade Loop — Cloud Functions Spec
## Version: Production-Ready Spec v2

---

## Design Principles

1. **Fail per strategy, not per run.** Each strategy is isolated in try/catch. One
   strategy erroring never blocks others from executing.
2. **Idempotent always.** Every live order is guarded by an idempotency key before
   the broker call. Cloud Functions may retry — this cannot place double orders.
3. **Broker is source of truth.** Portfolio state is always fetched fresh from the
   broker at cycle start. Never trust Firestore's cached snapshot for trade decisions.
4. **Claude output is untrusted.** Parse defensively, validate against schema, enforce
   risk limits independently. If Claude returns garbage, skip the cycle.
5. **Log everything.** Every cycle produces a complete cycle document regardless of
   outcome. Admin and user must always be able to see what happened and why.
6. **Degrade gracefully.** If news API is down, continue. If Claude is slow, timeout
   and skip. If broker is down, log and skip. Never hang.
7. **Money operations are synchronous and confirmable.** No fire-and-forget for orders.
   Wait for broker acknowledgement before logging a trade.

---

## Function Inventory

| Function | Trigger | Concurrency | Timeout | Memory |
|---|---|---|---|---|
| `tradeLoopScheduled` | Cloud Scheduler, every 15 min | max 5 instances | 540s | 1GB |
| `tradeLoopOnPriceEvent` | Firestore onWrite `priceEvents/*` | max 20 instances | 120s | 512MB |
| `priceMonitor` | Cloud Scheduler, every 5 min | max 2 instances | 120s | 512MB |
| `ibkrFillPoller` | Cloud Scheduler, every 2 min | max 1 instance | 60s | 256MB |
| `strategySetup` | HTTPS callable | max 10 | 120s | 512MB |
| `strategyReinterpret` | HTTPS callable | max 10 | 120s | 512MB |
| `emergencySellAll` | HTTPS callable | max 1 per user | 120s | 512MB |
| `emergencySellStrategy` | HTTPS callable | max 5 | 120s | 512MB |
| `toggleStrategyStatus` | HTTPS callable | max 10 | 30s | 256MB |
| `switchStrategyMode` | HTTPS callable | max 10 | 30s | 256MB |
| `manualCycleTrigger` | HTTPS callable | max 5 | 120s | 512MB |
| `computeDailyStats` | Cloud Scheduler, daily 00:05 UTC | max 1 | 540s | 1GB |
| `sendDailySummaries` | Cloud Scheduler, daily (per-user TZ) | max 10 | 120s | 512MB |
| `connectBroker` | HTTPS callable | max 10 | 60s | 256MB |
| `verifyBrokerConnection` | HTTPS callable | max 10 | 60s | 256MB |
| `generateTradeExport` | HTTPS callable | max 5 | 300s | 512MB |
| `cleanupExpiredData` | Cloud Scheduler, daily 02:00 UTC | max 1 | 300s | 256MB |

---

## `tradeLoopScheduled` — Main Scheduled Loop

```javascript
// functions/src/tradeLoop/scheduled.js

exports.tradeLoopScheduled = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'UTC',
  maxInstances: 5,
  timeoutSeconds: 540,
  memory: '1GiB',
}, async (event) => {

  const runId = nanoid(8);
  const startedAt = Date.now();
  logger.info(`[TradeLoop] Run ${runId} starting`);

  // Load all active strategies across all users using collection group query
  const snapshot = await db
    .collectionGroup('strategies')
    .where('status', '==', 'active')
    .get();

  const strategies = snapshot.docs.map(d => d.data());
  const now = new Date();

  // Filter by active hours
  const eligible = strategies.filter(s => isWithinActiveHours(s, now));

  logger.info(`[TradeLoop] Run ${runId}: ${strategies.length} active, ${eligible.length} eligible`);

  // Update systemMetrics with run start
  await incrementSystemMetric('cyclesToday', eligible.length);

  // Process strategies with controlled concurrency (max 10 at a time)
  const results = await pLimit(10)(
    eligible.map(strategy => () => runStrategyLoop(strategy, 'schedule', runId))
  );

  const errors = results.filter(r => r.error);
  const trades = results.filter(r => r.tradeExecuted);

  logger.info(
    `[TradeLoop] Run ${runId} complete. ` +
    `Duration: ${Date.now() - startedAt}ms. ` +
    `Strategies: ${eligible.length}. ` +
    `Trades: ${trades.length}. ` +
    `Errors: ${errors.length}.`
  );

  // Alert if error rate > 20% in this run
  if (eligible.length > 0 && errors.length / eligible.length > 0.2) {
    await logError({
      source: 'trade_loop',
      severity: 'critical',
      message: `High error rate in run ${runId}: ${errors.length}/${eligible.length} strategies failed`,
      metadata: { runId, errorStrategies: errors.map(e => e.strategyId) }
    });
  }
});
```

---

## `runStrategyLoop(strategy, triggeredBy, runId)`

Core execution for a single strategy. Called by both scheduled and event-driven loops.

```javascript
async function runStrategyLoop(strategy, triggeredBy, runId) {
  const { userId, strategyId } = strategy;
  const cycleId = `${Date.now()}_${nanoid(6)}`;
  const cycleRef = db.doc(
    `users/${userId}/strategies/${strategyId}/cycles/${cycleId}`
  );
  const phases = {};
  let phaseStart = Date.now();

  // Write cycle document immediately (status: in-progress)
  // So admin can see running cycles in real-time
  await cycleRef.set({
    cycleId, strategyId, userId,
    triggeredBy, runId,
    startedAt: FieldValue.serverTimestamp(),
    completedAt: null,
    error: false,
    tradeExecuted: false,
    decision: { action: 'pending' }
  });

  try {

    // ── PHASE 0: Broker health check ──────────────────────────────────────
    if (strategy.brokerHealth?.brokerUnreachable) {
      // Re-attempt broker ping before proceeding
      const brokerOk = await pingBroker(strategy.assets.broker, userId);
      if (!brokerOk) {
        return await skipCycle(cycleRef, 'broker_unreachable', { cycleId, strategyId });
      }
      // Broker is back — clear the flag
      await db.doc(`users/${userId}/strategies/${strategyId}`)
        .update({ 'brokerHealth.brokerUnreachable': false, 'brokerHealth.consecutiveFailures': 0 });
    }

    // ── PHASE 1: Portfolio snapshot (from broker — always fresh) ──────────
    phaseStart = Date.now();
    let portfolioSnapshot;
    try {
      portfolioSnapshot = await fetchPortfolio(strategy, userId);
    } catch (err) {
      await handleBrokerFailure(strategy, userId, err);
      return await skipCycle(cycleRef, 'broker_portfolio_fetch_failed', { cycleId, strategyId, error: err });
    }
    phases.portfolioMs = Date.now() - phaseStart;

    // ── PHASE 2: Drawdown check ───────────────────────────────────────────
    phaseStart = Date.now();
    const drawdownResult = checkDrawdown(portfolioSnapshot, strategy);
    if (drawdownResult.breached) {
      await autoPauseStrategy(strategy, userId, 'max_drawdown_exceeded');
      await sendNotification(userId, 'drawdown_limit_hit', strategy, drawdownResult);
      return await completeCycle(cycleRef, {
        portfolioSnapshot,
        drawdownCheck: drawdownResult,
        decision: {
          action: 'skip',
          reasoning: `Auto-paused: drawdown ${drawdownResult.currentDrawdownPct.toFixed(1)}% ` +
                     `exceeded limit ${drawdownResult.limitPct}%`
        },
        phases
      });
    }
    phases.drawdownMs = Date.now() - phaseStart;

    // ── PHASE 3: Stop-loss and take-profit checks ─────────────────────────
    phaseStart = Date.now();
    const stopChecks = await checkStopLossAndTakeProfit(strategy, userId, portfolioSnapshot, cycleId);
    // stopChecks may generate trades immediately (stop-loss/take-profit orders)
    phases.stopCheckMs = Date.now() - phaseStart;

    // ── PHASE 4: Market data ──────────────────────────────────────────────
    phaseStart = Date.now();
    let marketSnapshot;
    try {
      marketSnapshot = await fetchMarketData(strategy, userId);
    } catch (err) {
      await handleBrokerFailure(strategy, userId, err);
      return await skipCycle(cycleRef, 'market_data_fetch_failed', { cycleId, strategyId, error: err });
    }

    // Staleness guard
    if (marketSnapshot.dataStale) {
      logger.warn(`[Cycle ${cycleId}] Market data stale (${marketSnapshot.dataFreshnessMs}ms) — skipping`);
      return await skipCycle(cycleRef, 'market_data_stale', {
        cycleId, strategyId, marketSnapshot, portfolioSnapshot
      });
    }
    phases.marketDataMs = Date.now() - phaseStart;

    // ── PHASE 5: External data (news, fear & greed) ───────────────────────
    phaseStart = Date.now();
    marketSnapshot = await enrichWithExternalData(marketSnapshot, strategy);
    phases.externalDataMs = Date.now() - phaseStart;

    // ── PHASE 6: Claude decision ──────────────────────────────────────────
    phaseStart = Date.now();
    let claudeResult;
    try {
      claudeResult = await getClaudeDecision(strategy, portfolioSnapshot, marketSnapshot);
    } catch (err) {
      // Claude failure: in rule mode, fall back to deterministic evaluation
      // In autonomous mode, skip the cycle
      if (strategy.decisionMode === 'rule_interpreter') {
        claudeResult = await fallbackRuleEvaluation(strategy, marketSnapshot, portfolioSnapshot);
      } else {
        await logError({ source: 'claude_api', severity: 'error', userId, strategyId, cycleId,
                         message: err.message, stack: err.stack });
        return await skipCycle(cycleRef, 'claude_api_failed', {
          cycleId, strategyId, marketSnapshot, portfolioSnapshot,
          errorMessage: err.message
        });
      }
    }
    phases.claudeMs = Date.now() - phaseStart;

    // ── PHASE 7: Validate decision ────────────────────────────────────────
    phaseStart = Date.now();
    const { decision, validationNotes } = validateDecision(
      claudeResult.decision, strategy, portfolioSnapshot
    );
    phases.validationMs = Date.now() - phaseStart;

    // ── PHASE 8: Execute or simulate ──────────────────────────────────────
    phaseStart = Date.now();
    let tradeResult = null;
    let skippedReason = null;

    if (decision.action === 'buy' || decision.action === 'sell') {
      const idempotencyKey = `${strategyId}_${cycleId}_${decision.side}_${decision.symbol}`;

      // Check idempotency before ANY broker call
      const alreadyPlaced = await checkIdempotencyKey(idempotencyKey);
      if (alreadyPlaced) {
        logger.warn(`[Cycle ${cycleId}] Idempotency key exists — skipping duplicate order`);
        skippedReason = 'duplicate_prevented_by_idempotency';
      } else {
        await writeIdempotencyKey(idempotencyKey, { userId, strategyId, cycleId });
        tradeResult = await executeOrSimulate(strategy, decision, userId, cycleId, claudeResult);
      }
    } else if (decision.action === 'suggest_asset') {
      await recordAssetSuggestion(strategy, userId, decision);
      if (strategy.notifications.onAssetSuggestion) {
        await sendNotification(userId, 'asset_suggested', strategy, decision);
      }
    }
    phases.executionMs = Date.now() - phaseStart;

    // ── PHASE 9: Update strategy stats ────────────────────────────────────
    phaseStart = Date.now();
    await updateStrategyStats(strategy, userId, portfolioSnapshot, claudeResult, tradeResult);
    phases.statsMs = Date.now() - phaseStart;

    // ── PHASE 10: Notifications ───────────────────────────────────────────
    if (tradeResult && strategy.notifications.onTrade) {
      await sendNotification(userId, 'trade_executed', strategy, tradeResult);
    }
    if (strategy.notifications.onCycle) {
      await sendNotification(userId, 'cycle_complete', strategy, decision);
    }
    if (decision.flagForReview) {
      await sendNotification(userId, 'strategy_flagged_for_review', strategy, decision);
    }

    // ── PHASE 11: Complete cycle log ──────────────────────────────────────
    phases.loggingStart = Date.now();
    const completed = await completeCycle(cycleRef, {
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
      phases
    });
    phases.loggingMs = Date.now() - phases.loggingStart;

    return { cycleId, strategyId, tradeExecuted: tradeResult !== null, error: false };

  } catch (err) {
    // Unexpected error — log and mark cycle as failed
    logger.error(`[Cycle ${cycleId}] Unexpected error: ${err.message}`, err);

    await logError({
      source: 'trade_loop', severity: 'error',
      userId, strategyId, cycleId,
      message: err.message, stack: err.stack,
      metadata: { triggeredBy, runId }
    });

    await cycleRef.update({
      completedAt: FieldValue.serverTimestamp(),
      error: true,
      errorSource: 'unknown',
      errorMessage: err.message,
      'decision.action': 'error'
    });

    await incrementBrokerFailureCount(strategy, userId);

    return { cycleId, strategyId, tradeExecuted: false, error: true };
  }
}
```

---

## Phase 4: Fetch Market Data

```javascript
async function fetchMarketData(strategy, userId) {
  const { watchlist, broker } = strategy.assets;
  const now = Date.now();
  const assetData = [];

  for (const symbol of watchlist) {
    // Check shared market data cache first (avoids duplicate broker calls
    // when multiple strategies watch the same asset)
    const cacheKey = `${symbol}_15m`;
    const cached = await getMarketDataCache(cacheKey);
    let candles;

    if (cached && (now - cached.fetchedAt.toMillis()) < 14 * 60 * 1000) {
      // Cache valid for 14 min (slightly less than cycle interval)
      candles = cached.candles;
    } else {
      candles = await fetchOHLCV(broker, userId, symbol, '15m', 200);
      await setMarketDataCache(cacheKey, { symbol, interval: '15m', broker, candles, fetchedAt: now });
    }

    if (!candles || candles.length < 50) {
      throw new Error(`Insufficient candle data for ${symbol}: ${candles?.length ?? 0} candles`);
    }

    const closes = candles.map(c => c.c);
    const highs  = candles.map(c => c.h);
    const lows   = candles.map(c => c.l);
    const vols   = candles.map(c => c.v);
    const newest = candles[candles.length - 1];
    const oldest24h = candles[Math.max(0, candles.length - 96)]; // 96 × 15min = 24h

    // Compute all indicators
    const rsi14       = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0] ?? null;
    const macdResult  = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).slice(-1)[0];
    const ema20       = EMA.calculate({ values: closes, period: 20 }).slice(-1)[0] ?? null;
    const ema50       = EMA.calculate({ values: closes, period: 50 }).slice(-1)[0] ?? null;
    const ema200      = closes.length >= 200 ? EMA.calculate({ values: closes, period: 200 }).slice(-1)[0] : null;
    const bbResult    = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }).slice(-1)[0];
    const atr14       = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).slice(-1)[0] ?? null;

    const dataFreshnessMs = now - newest.t;

    assetData.push({
      symbol,
      price:            newest.c,
      open24h:          oldest24h.o,
      high24h:          Math.max(...highs.slice(-96)),
      low24h:           Math.min(...lows.slice(-96)),
      close24h:         newest.c,
      volume24h:        vols.slice(-96).reduce((a, b) => a + b, 0),
      priceChangePct24h: ((newest.c - oldest24h.o) / oldest24h.o) * 100,
      rsi14:            rsi14 !== undefined ? parseFloat(rsi14.toFixed(4)) : null,
      macdLine:         macdResult?.MACD?.toFixed(6) ?? null,
      macdSignal:       macdResult?.signal?.toFixed(6) ?? null,
      macdHistogram:    macdResult?.histogram?.toFixed(6) ?? null,
      ema20:            ema20?.toFixed(4) ?? null,
      ema50:            ema50?.toFixed(4) ?? null,
      ema200:           ema200?.toFixed(4) ?? null,
      bbUpper:          bbResult?.upper?.toFixed(4) ?? null,
      bbMiddle:         bbResult?.middle?.toFixed(4) ?? null,
      bbLower:          bbResult?.lower?.toFixed(4) ?? null,
      atr14:            atr14?.toFixed(4) ?? null,
      candlesUsed:      candles.length,
      dataFreshnessMs
    });
  }

  const newestFreshness = Math.max(...assetData.map(a => a.dataFreshnessMs));

  return {
    fetchedAt: new Date(),
    dataFreshnessMs: newestFreshness,
    dataStale: newestFreshness > 20 * 60 * 1000,  // > 20 min = stale
    assets: assetData,
    fearGreedIndex: null,
    fearGreedLabel: null,
    newsHeadlines: null,
    newsSkipped: false,
    newsSkipReason: null
  };
}
```

---

## Phase 5: External Data Enrichment

```javascript
async function enrichWithExternalData(marketSnapshot, strategy) {
  const enriched = { ...marketSnapshot };

  // Fear & Greed (crypto only)
  if (strategy.assets.broker === 'binance') {
    try {
      const fg = await fetchFearGreedCached();
      enriched.fearGreedIndex = fg.value;
      enriched.fearGreedLabel = fg.label;
      enriched.fearGreedCachedAt = fg.fetchedAt;
    } catch (err) {
      logger.warn(`Fear & Greed fetch failed: ${err.message}. Continuing without it.`);
    }
  }

  // News headlines
  try {
    const quotaOk = await checkNewsQuota();
    if (!quotaOk) {
      enriched.newsSkipped = true;
      enriched.newsSkipReason = 'quota_exhausted';
    } else {
      const headlines = await fetchNewsCached(strategy.assets.watchlist);
      enriched.newsHeadlines = headlines;
    }
  } catch (err) {
    logger.warn(`News fetch failed: ${err.message}. Continuing without news.`);
    enriched.newsSkipped = true;
    enriched.newsSkipReason = 'api_error';
  }

  return enriched;
}
```

---

## Phase 6: Claude Decision

### Rule Interpreter Mode

```javascript
async function getClaudeDecision_RuleInterpreter(strategy, portfolio, market) {
  const { rules } = strategy;
  const activeRules = rules.filter(r => r.active);

  // Evaluate all rules deterministically (no Claude call yet)
  const triggered = [];
  for (const rule of activeRules) {
    if (evaluateCondition(rule.condition, market, portfolio)) {
      triggered.push(rule);
    }
  }

  if (triggered.length === 0) {
    // No Claude call needed for a pure hold
    return {
      decision: {
        action: 'hold',
        reasoning: `No rules triggered. Monitoring ${activeRules.length} rules.`,
        rulesTriggered: [],
        confidence: null
      },
      claudeCalled: false,
      promptTokens: 0, completionTokens: 0, costUsd: 0
    };
  }

  // Sort by priority, take highest
  const topRule = [...triggered].sort((a, b) => a.priority - b.priority)[0];

  // Call Claude for reasoning summary only
  const prompt = buildRuleReasoningPrompt(topRule, triggered, market, portfolio, strategy);
  const { content, usage, latencyMs } = await callClaude(prompt);
  const parsed = parseClaudeJSON(content);

  if (!parsed.ok) {
    // Claude reasoning failed — still execute the rule, just without a good summary
    logger.warn(`Rule reasoning parse failed: ${parsed.error}`);
    return {
      decision: {
        action: parseActionFromRule(topRule),
        symbol: parseSymbolFromRule(topRule),
        side: parseSideFromRule(topRule),
        notionalUsd: parseNotionalFromRule(topRule, portfolio),
        reasoning: `Rule triggered: ${topRule.condition} → ${topRule.action}`,
        rulesTriggered: triggered.map(r => r.ruleId),
        confidence: null
      },
      claudeCalled: true,
      claudeParseSuccess: false,
      claudeParseError: parsed.error,
      claudeRawResponse: content,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      costUsd: estimateCost(usage),
      latencyMs
    };
  }

  return {
    decision: {
      action: parseActionFromRule(topRule),
      symbol: parseSymbolFromRule(topRule),
      side: parseSideFromRule(topRule),
      notionalUsd: parseNotionalFromRule(topRule, portfolio),
      reasoning: parsed.data.reasoning,
      confidence: parsed.data.confidence,
      rulesTriggered: triggered.map(r => r.ruleId)
    },
    claudeCalled: true,
    claudeParseSuccess: true,
    claudeRawResponse: content,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    costUsd: estimateCost(usage),
    latencyMs
  };
}
```

### Autonomous Reasoner Mode

```javascript
async function getClaudeDecision_Autonomous(strategy, portfolio, market) {
  const prompt = buildAutonomousPrompt(strategy, portfolio, market);
  const { content, usage, latencyMs } = await callClaude(prompt);
  const parsed = parseClaudeJSON(content);

  if (!parsed.ok) {
    throw new Error(`Claude autonomous decision parse failed: ${parsed.error}. Raw: ${content.slice(0, 200)}`);
  }

  // Validate required fields exist
  const required = ['action', 'reasoning'];
  for (const field of required) {
    if (parsed.data[field] === undefined) {
      throw new Error(`Claude response missing required field: ${field}`);
    }
  }

  // Validate action is known
  const validActions = ['buy', 'sell', 'hold', 'suggest_asset'];
  if (!validActions.includes(parsed.data.action)) {
    throw new Error(`Claude returned unknown action: ${parsed.data.action}`);
  }

  return {
    decision: parsed.data,
    claudeCalled: true,
    claudeParseSuccess: true,
    claudeRawResponse: content,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    costUsd: estimateCost(usage),
    latencyMs
  };
}
```

### `callClaude(prompt)` — with timeout and retry

```javascript
async function callClaude(prompt, maxRetries = 2) {
  const apiKey = await secretManager.getSecret('ANTHROPIC_API_KEY');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    try {
      const startMs = Date.now();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1024,
          temperature: 0,        // deterministic output for financial decisions
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.status === 529 || response.status === 503) {
        // Claude overloaded — retry with backoff
        if (attempt < maxRetries) {
          await sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`Claude API overloaded after ${maxRetries + 1} attempts`);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Claude API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      return {
        content: data.content[0].text,
        usage: data.usage,
        latencyMs: Date.now() - startMs
      };

    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error('Claude API timeout after 30 seconds');
      }
      if (attempt === maxRetries) throw err;
      await sleep(2000 * Math.pow(2, attempt));
    }
  }
}
```

---

## Phase 7: Decision Validation

```javascript
function validateDecision(decision, strategy, portfolio) {
  const notes = [];
  let d = { ...decision };

  if (d.action !== 'buy' && d.action !== 'sell') {
    return { decision: d, validationNotes: notes };
  }

  // 1. Symbol must be in watchlist
  if (!strategy.assets.watchlist.includes(d.symbol)) {
    notes.push(`REJECTED: Symbol ${d.symbol} not in watchlist`);
    return { decision: { ...d, action: 'hold', reasoning: `Rejected: unknown symbol ${d.symbol}` }, validationNotes: notes };
  }

  // 2. Notional must be positive
  if (!d.notionalUsd || d.notionalUsd <= 0) {
    notes.push(`REJECTED: Invalid notionalUsd ${d.notionalUsd}`);
    return { decision: { ...d, action: 'hold', reasoning: 'Rejected: invalid trade size' }, validationNotes: notes };
  }

  // 3. Max position size per trade
  const maxNotional = portfolio.totalValueUsd * (strategy.risk.maxPositionSizePct / 100);
  if (d.notionalUsd > maxNotional) {
    d.notionalUsd = maxNotional;
    notes.push(`CLAMPED: notionalUsd reduced to max position size ${maxNotional.toFixed(2)}`);
  }

  // 4. Min confidence (autonomous mode)
  if (strategy.risk.minConfidenceToTrade > 0 && d.confidence !== null) {
    if (d.confidence < strategy.risk.minConfidenceToTrade) {
      notes.push(`REJECTED: Confidence ${d.confidence} below minimum ${strategy.risk.minConfidenceToTrade}`);
      return {
        decision: { ...d, action: 'hold', reasoning: `Low confidence: ${d.confidence} < ${strategy.risk.minConfidenceToTrade}` },
        validationNotes: notes
      };
    }
  }

  if (d.action === 'buy') {
    // 5. Cash available
    if (d.notionalUsd > portfolio.cashUsd) {
      d.notionalUsd = portfolio.cashUsd * 0.95;  // 95% to leave buffer for fees
      notes.push(`CLAMPED: notionalUsd reduced to 95% of cash ${(portfolio.cashUsd * 0.95).toFixed(2)}`);
    }
    if (d.notionalUsd < 1.0) {
      notes.push(`REJECTED: notionalUsd ${d.notionalUsd} below $1 minimum`);
      return { decision: { ...d, action: 'hold', reasoning: 'Insufficient cash' }, validationNotes: notes };
    }

    // 6. Max open positions
    const openCount = portfolio.positions.filter(p => p.quantity > 0).length;
    if (openCount >= strategy.risk.maxOpenPositions) {
      notes.push(`REJECTED: At max open positions (${strategy.risk.maxOpenPositions})`);
      return { decision: { ...d, action: 'hold', reasoning: 'Max open positions reached' }, validationNotes: notes };
    }

    // 7. Already at max position in this asset
    const existingPosition = portfolio.positions.find(p => p.symbol === d.symbol);
    if (existingPosition) {
      const currentExposurePct = (existingPosition.currentValueUsd / portfolio.totalValueUsd) * 100;
      if (currentExposurePct >= strategy.risk.maxPositionSizePct) {
        notes.push(`REJECTED: Already at max position in ${d.symbol} (${currentExposurePct.toFixed(1)}%)`);
        return { decision: { ...d, action: 'hold', reasoning: `Max position size reached for ${d.symbol}` }, validationNotes: notes };
      }
      // Reduce buy size so total position doesn't exceed max
      const remainingAllowedUsd = maxNotional - existingPosition.currentValueUsd;
      if (d.notionalUsd > remainingAllowedUsd) {
        d.notionalUsd = remainingAllowedUsd;
        notes.push(`CLAMPED: notionalUsd reduced to ${remainingAllowedUsd.toFixed(2)} to respect position limit`);
      }
    }

  } else if (d.action === 'sell') {
    // 8. Must have a position to sell
    const position = portfolio.positions.find(p => p.symbol === d.symbol);
    if (!position || position.quantity <= 0) {
      notes.push(`REJECTED: No position in ${d.symbol} to sell`);
      return { decision: { ...d, action: 'hold', reasoning: `No position to sell: ${d.symbol}` }, validationNotes: notes };
    }
  }

  return { decision: d, validationNotes: notes };
}
```

---

## Phase 8: Execute or Simulate

```javascript
async function executeOrSimulate(strategy, decision, userId, cycleId, claudeResult) {
  const tradeId = `${Date.now()}_${nanoid(6)}`;
  const tradeRef = db.doc(
    `users/${userId}/strategies/${strategy.strategyId}/trades/${tradeId}`
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
    source: 'strategy',
    orderType: 'market',
    requestedNotionalUsd: decision.notionalUsd,
    claudeReasoning: decision.reasoning,
    claudeConfidence: decision.confidence ?? null,
    claudeMode: strategy.decisionMode,
    rulesTriggered: decision.rulesTriggered ?? null,
    requestedAt: FieldValue.serverTimestamp(),
  };

  if (strategy.mode === 'paper') {
    // Simulate: use current market price, no broker call
    const currentPrice = await getSpotPrice(strategy.assets.broker, userId, decision.symbol);
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
      openingTradeIds: [],  // resolved by position updater
      realizedPnlUsd: null,
      realizedPnlPct: null,
      holdingPeriodMs: null,
      costBasisUsd: null,
      proceedsUsd: null,
      netProceedsUsd: null,
      acquisitionDate: null,
      isShortTermGain: null,
      submittedAt: FieldValue.serverTimestamp(),
      executedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)  // TTL: 1 year
    };

    await tradeRef.set(tradeDoc);
    await updatePositionAfterTrade(strategy, userId, decision, qty, currentPrice, tradeId);

    return { tradeId, mode: 'paper', executedPriceUsd: currentPrice, executedQuantity: qty };

  } else {
    // Live: place real order
    const broker = getBrokerAdapter(strategy.assets.broker, userId, false);

    let brokerResult;
    try {
      brokerResult = await broker.placeOrder({
        symbol: decision.symbol,
        side: decision.side,
        notionalUsd: decision.notionalUsd
      });
    } catch (err) {
      // Order placement failed — log but don't mark trade as executed
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
        executedAt: FieldValue.serverTimestamp()
      });

      await logError({
        source: `broker_${strategy.assets.broker}`, severity: 'error',
        userId, strategyId: strategy.strategyId, cycleId,
        message: `Order placement failed: ${err.message}`,
        metadata: { symbol: decision.symbol, side: decision.side, notionalUsd: decision.notionalUsd }
      });

      throw err;
    }

    const tradeDoc = {
      ...baseTradeDoc,
      executedQuantity: brokerResult.executedQty,
      executedPriceUsd: brokerResult.executedPrice,
      executedNotionalUsd: brokerResult.executedNotionalUsd,
      slippageUsd: Math.abs(brokerResult.executedPrice - (decision.notionalUsd / brokerResult.executedQty)) * brokerResult.executedQty,
      feeUsd: brokerResult.feeUsd,
      feeCurrency: brokerResult.feeCurrency,
      feeAsset: brokerResult.feeAsset ?? null,
      brokerOrderId: brokerResult.orderId,
      brokerStatus: brokerResult.status,
      brokerRawResponse: JSON.stringify(brokerResult.raw),
      isOpeningTrade: decision.side === 'buy',
      isClosingTrade: decision.side === 'sell',
      openingTradeIds: [],
      realizedPnlUsd: null,
      realizedPnlPct: null,
      holdingPeriodMs: null,
      costBasisUsd: null,
      proceedsUsd: null,
      netProceedsUsd: null,
      acquisitionDate: null,
      isShortTermGain: null,
      fillConfirmedAt: brokerResult.status === 'filled' ? FieldValue.serverTimestamp() : null,
      submittedAt: FieldValue.serverTimestamp(),
      executedAt: brokerResult.status === 'filled' ? FieldValue.serverTimestamp() : null
    };

    await tradeRef.set(tradeDoc);

    // For IBKR async fills: add to pending fills collection
    if (strategy.assets.broker === 'ibkr' && brokerResult.status !== 'filled') {
      await db.collection('ibkrPendingFills').add({
        userId, strategyId: strategy.strategyId, tradeId,
        brokerOrderId: brokerResult.orderId,
        symbol: decision.symbol, side: decision.side,
        submittedAt: FieldValue.serverTimestamp(),
        lastCheckedAt: null, checkCount: 0,
        status: 'pending',
        expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    } else {
      // Binance fills are synchronous — update position immediately
      await updatePositionAfterTrade(
        strategy, userId, decision,
        brokerResult.executedQty, brokerResult.executedPrice, tradeId
      );
    }

    return {
      tradeId, mode: 'live',
      executedPriceUsd: brokerResult.executedPrice,
      executedQuantity: brokerResult.executedQty,
      executedNotionalUsd: brokerResult.executedNotionalUsd
    };
  }
}
```

---

## Stop-Loss and Take-Profit Checker

Runs at the start of every cycle, before the main Claude decision, checking all open positions.

```javascript
async function checkStopLossAndTakeProfit(strategy, userId, portfolio, cycleId) {
  const stopChecks = [];
  const takeProfitChecks = [];

  if (!strategy.risk.stopLossPerTradePct && !strategy.risk.takeProfitPerTradePct) {
    return { stopChecks, takeProfitChecks };
  }

  for (const position of portfolio.positions.filter(p => p.quantity > 0)) {
    const pnlPct = position.unrealizedPnlPct;

    // Stop-loss check
    if (strategy.risk.stopLossPerTradePct) {
      const triggered = pnlPct <= -Math.abs(strategy.risk.stopLossPerTradePct);
      let tradeId = null;

      if (triggered) {
        logger.info(`[StopLoss] ${position.symbol} at ${pnlPct.toFixed(2)}% — triggering sell`);
        const result = await executeOrSimulate(strategy, {
          action: 'sell', side: 'sell',
          symbol: position.symbol,
          notionalUsd: position.currentValueUsd,
          reasoning: `Stop-loss triggered: position at ${pnlPct.toFixed(2)}%, limit ${-strategy.risk.stopLossPerTradePct}%`,
          confidence: null, rulesTriggered: null
        }, userId, cycleId, null);
        tradeId = result.tradeId;
        await sendNotification(userId, 'stop_loss_triggered', strategy, { symbol: position.symbol, pnlPct });
      }

      stopChecks.push({
        symbol: position.symbol,
        currentPnlPct: pnlPct,
        stopLossPct: strategy.risk.stopLossPerTradePct,
        triggered,
        tradeId
      });
    }

    // Take-profit check
    if (strategy.risk.takeProfitPerTradePct) {
      const triggered = pnlPct >= Math.abs(strategy.risk.takeProfitPerTradePct);
      let tradeId = null;

      if (triggered) {
        logger.info(`[TakeProfit] ${position.symbol} at ${pnlPct.toFixed(2)}% — triggering sell`);
        const result = await executeOrSimulate(strategy, {
          action: 'sell', side: 'sell',
          symbol: position.symbol,
          notionalUsd: position.currentValueUsd,
          reasoning: `Take-profit triggered: position at ${pnlPct.toFixed(2)}%, target ${strategy.risk.takeProfitPerTradePct}%`,
          confidence: null, rulesTriggered: null
        }, userId, cycleId, null);
        tradeId = result.tradeId;
      }

      takeProfitChecks.push({
        symbol: position.symbol,
        currentPnlPct: pnlPct,
        takeProfitPct: strategy.risk.takeProfitPerTradePct,
        triggered,
        tradeId
      });
    }
  }

  return { stopChecks, takeProfitChecks };
}
```

---

## `ibkrFillPoller` — Async Fill Confirmation

```javascript
exports.ibkrFillPoller = onSchedule({
  schedule: 'every 2 minutes',
  maxInstances: 1,
  timeoutSeconds: 60,
}, async () => {
  const pending = await db.collection('ibkrPendingFills')
    .where('status', '==', 'pending')
    .get();

  for (const doc of pending.docs) {
    const fill = doc.data();

    if (fill.checkCount > 20) {
      // 20 checks × 2 min = 40 min without fill — mark as timeout
      await doc.ref.update({ status: 'timeout', resolvedAt: FieldValue.serverTimestamp() });
      await logError({
        source: 'broker_ibkr', severity: 'error',
        userId: fill.userId, strategyId: fill.strategyId,
        message: `IBKR order ${fill.brokerOrderId} timed out after 40 minutes`,
        metadata: { tradeId: fill.tradeId, symbol: fill.symbol }
      });
      await sendNotification(fill.userId, 'broker_error', null,
        { message: `Order for ${fill.symbol} timed out. Please check IBKR directly.` });
      continue;
    }

    try {
      const orderStatus = await getIBKROrderStatus(fill.userId, fill.brokerOrderId);

      if (orderStatus.status === 'Filled') {
        // Update trade document with fill details
        const tradeRef = db.doc(
          `users/${fill.userId}/strategies/${fill.strategyId}/trades/${fill.tradeId}`
        );
        await tradeRef.update({
          brokerStatus: 'filled',
          executedPriceUsd: orderStatus.avgPrice,
          executedQuantity: orderStatus.filledQuantity,
          executedNotionalUsd: orderStatus.avgPrice * orderStatus.filledQuantity,
          feeUsd: orderStatus.commission ?? 0,
          fillConfirmedAt: FieldValue.serverTimestamp(),
          executedAt: FieldValue.serverTimestamp()
        });

        // Update position
        const tradeData = (await tradeRef.get()).data();
        await updatePositionAfterTrade(
          { strategyId: fill.strategyId, assets: { broker: 'ibkr' } },
          fill.userId,
          { side: fill.side, symbol: fill.symbol },
          orderStatus.filledQuantity, orderStatus.avgPrice, fill.tradeId
        );

        await doc.ref.update({ status: 'filled', resolvedAt: FieldValue.serverTimestamp() });

      } else if (['Cancelled', 'Inactive'].includes(orderStatus.status)) {
        await doc.ref.update({ status: 'failed', resolvedAt: FieldValue.serverTimestamp() });
        await logError({
          source: 'broker_ibkr', severity: 'warning',
          userId: fill.userId,
          message: `IBKR order ${fill.brokerOrderId} cancelled/inactive`,
          metadata: { symbol: fill.symbol, status: orderStatus.status }
        });
      } else {
        // Still pending
        await doc.ref.update({
          lastCheckedAt: FieldValue.serverTimestamp(),
          checkCount: FieldValue.increment(1)
        });
      }
    } catch (err) {
      logger.error(`ibkrFillPoller error for ${fill.brokerOrderId}: ${err.message}`);
      await doc.ref.update({
        lastCheckedAt: FieldValue.serverTimestamp(),
        checkCount: FieldValue.increment(1)
      });
    }
  }
});
```

---

## `emergencySellAll` — HTTPS Callable

Rate limited: 1 call per user per 60 seconds (enforced by idempotency key with 60s TTL).

```javascript
exports.emergencySellAll = onCall({
  maxInstances: 10,
  timeoutSeconds: 120,
}, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Must be authenticated');

  // Rate limit: one emergency call per 60s per user
  const rateLimitKey = `emergency_${userId}`;
  if (await checkIdempotencyKey(rateLimitKey)) {
    throw new HttpsError('resource-exhausted', 'Emergency sell already in progress');
  }
  await writeIdempotencyKey(rateLimitKey, { userId }, 60);  // 60s TTL

  logger.info(`[Emergency] User ${userId} triggered emergency sell all`);

  // 1. Immediately pause all active strategies (prevent new trades)
  const strategies = await db.collectionGroup('strategies')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .get();

  const pauseOps = strategies.docs.map(doc =>
    doc.ref.update({
      status: 'paused',
      pausedAt: FieldValue.serverTimestamp(),
      statusHistory: FieldValue.arrayUnion({
        status: 'paused', changedAt: new Date(), reason: 'emergency_sell_all'
      })
    })
  );
  await Promise.all(pauseOps);

  // 2. Fetch live positions from each connected broker
  const user = (await db.doc(`users/${userId}`).get()).data();
  const results = { sold: [], failed: [], total: 0 };

  const brokerSells = [];

  if (user.brokers?.binance?.connected) {
    const positions = await fetchBinanceLivePositions(userId);
    for (const pos of positions.filter(p => p.quantity > 0 && p.symbol !== 'USDT')) {
      brokerSells.push({ broker: 'binance', symbol: pos.symbol, quantity: pos.quantity, valueUsd: pos.valueUsd });
    }
  }

  if (user.brokers?.ibkr?.connected) {
    const positions = await fetchIBKRLivePositions(userId);
    for (const pos of positions.filter(p => p.quantity > 0)) {
      brokerSells.push({ broker: 'ibkr', symbol: pos.symbol, quantity: pos.quantity, valueUsd: pos.valueUsd });
    }
  }

  results.total = brokerSells.length;

  // 3. Sell each position independently (allSettled — never let one failure stop others)
  const sellResults = await Promise.allSettled(
    brokerSells.map(async pos => {
      const broker = getBrokerAdapter(pos.broker, userId, false);
      const result = await broker.placeOrder({
        symbol: pos.symbol,
        side: 'sell',
        quantity: pos.quantity
      });

      // Log as trade with source='emergency'
      const tradeId = `${Date.now()}_${nanoid(6)}`;
      await db.collection('emergencyTrades').add({
        tradeId, userId,
        broker: pos.broker, symbol: pos.symbol,
        side: 'sell', source: 'emergency',
        mode: 'live',
        executedQuantity: result.executedQty,
        executedPriceUsd: result.executedPrice,
        executedNotionalUsd: result.executedNotionalUsd,
        feeUsd: result.feeUsd ?? 0,
        brokerOrderId: result.orderId,
        requestedAt: FieldValue.serverTimestamp(),
        executedAt: FieldValue.serverTimestamp()
      });

      return { symbol: pos.symbol, broker: pos.broker, sold: true, tradeId };
    })
  );

  for (const r of sellResults) {
    if (r.status === 'fulfilled') {
      results.sold.push(r.value);
    } else {
      results.failed.push({ error: r.reason?.message ?? 'Unknown error' });
      logger.error(`Emergency sell failed for a position: ${r.reason}`);
    }
  }

  // 4. Notify user with full results
  await sendNotification(userId, 'emergency_sell_executed', null, results);

  // 5. Log to audit log
  await db.collection('adminAuditLog').add({
    adminUserId: userId, adminEmail: 'self',
    action: 'emergency_sell_all',
    targetType: 'user', targetId: userId,
    before: null, after: { results },
    performedAt: FieldValue.serverTimestamp()
  });

  return results;
});
```

---

## `computeDailyStats` — Scheduled Daily

```javascript
exports.computeDailyStats = onSchedule({
  schedule: '5 0 * * *',  // 00:05 UTC daily
  maxInstances: 1,
  timeoutSeconds: 540,
  memory: '1GiB',
}, async () => {
  const today = new Date().toISOString().split('T')[0];  // YYYY-MM-DD

  // Aggregate system metrics
  const systemSnapshot = await buildSystemMetricsSnapshot();

  // Save daily snapshot
  await db.doc(`systemMetrics/${today}`).set({
    ...systemSnapshot, date: today,
    capturedAt: FieldValue.serverTimestamp()
  });

  // Reset daily rolling counters on current
  await db.doc('systemMetrics/current').update({
    cyclesToday: 0, tradesToday: 0, liveTradesToday: 0, paperTradesToday: 0,
    notionalVolumeUsdToday: 0, claudeCallsToday: 0, claudeCostUsdToday: 0,
    binanceApiErrorsToday: 0, ibkrApiErrorsToday: 0,
    fcmSentToday: 0, fcmFailedToday: 0, errorCyclesToday: 0,
    newUsersToday: 0, activeUsersLast24h: 0
  });

  // Recompute Sharpe/Sortino for all active strategies
  const strategies = await db.collectionGroup('strategies')
    .where('status', 'in', ['active', 'paused'])
    .get();

  for (const stratDoc of strategies.docs) {
    const strategy = stratDoc.data();
    const trades = await db
      .collection(`users/${strategy.userId}/strategies/${strategy.strategyId}/trades`)
      .where('isClosingTrade', '==', true)
      .where('mode', '==', 'live')
      .orderBy('executedAt', 'desc')
      .limit(365)
      .get();

    if (trades.size < 5) continue;  // need at least 5 trades for meaningful metrics

    const pnlSeries = trades.docs.map(d => d.data().realizedPnlPct ?? 0);
    const sharpe = computeAnnualisedSharpe(pnlSeries);
    const sortino = computeAnnualisedSortino(pnlSeries);

    await stratDoc.ref.update({
      'stats.sharpeRatio': sharpe,
      'stats.sortinoRatio': sortino,
      'stats.lastRiskMetricsComputedAt': FieldValue.serverTimestamp()
    });
  }
});
```

---

## Rate Limiting on HTTPS Callable Functions

All HTTPS callable functions enforce per-user rate limits using Firestore-backed
counters to prevent abuse:

```javascript
async function enforceRateLimit(userId, action, maxCalls, windowSeconds) {
  const key = `rateLimits/${userId}_${action}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  const doc = await db.doc(key).get();
  const data = doc.data() ?? { calls: [], lastReset: now };

  // Remove calls outside window
  const recentCalls = (data.calls ?? []).filter(t => t > windowStart);

  if (recentCalls.length >= maxCalls) {
    throw new HttpsError('resource-exhausted',
      `Rate limit exceeded: ${maxCalls} calls per ${windowSeconds}s for ${action}`);
  }

  recentCalls.push(now);
  await db.doc(key).set({ calls: recentCalls, lastReset: now },
    { merge: true });
}

// Example usage in a callable:
await enforceRateLimit(userId, 'strategy_setup', 5, 3600);  // 5 per hour
await enforceRateLimit(userId, 'emergency_sell', 1, 60);     // 1 per minute
await enforceRateLimit(userId, 'manual_cycle', 3, 60);       // 3 per minute
```

---

## Error Codes Reference

| Code | Source | Severity | Description |
|---|---|---|---|
| `BROKER_INSUFFICIENT_BALANCE` | broker | warning | Not enough cash to place order |
| `BROKER_INVALID_SYMBOL` | broker | error | Symbol not recognised by broker |
| `BROKER_RATE_LIMITED` | broker | warning | Hit API rate limit, retrying |
| `BROKER_UNREACHABLE` | broker | critical | Cannot connect to broker API |
| `BROKER_ORDER_REJECTED` | broker | error | Broker rejected the order |
| `CLAUDE_TIMEOUT` | claude_api | error | Claude took > 30s |
| `CLAUDE_OVERLOADED` | claude_api | warning | Claude 529, retrying |
| `CLAUDE_PARSE_FAILED` | claude_api | error | Response is not valid JSON |
| `CLAUDE_INVALID_ACTION` | claude_api | error | Response has unknown action |
| `MARKET_DATA_STALE` | trade_loop | warning | Candle data > 20 min old |
| `MARKET_DATA_INSUFFICIENT` | trade_loop | error | < 50 candles for indicators |
| `DRAWDOWN_LIMIT_EXCEEDED` | trade_loop | warning | Strategy auto-paused |
| `IDEMPOTENCY_DUPLICATE` | trade_loop | warning | Duplicate order prevented |
| `IBKR_TOKEN_EXPIRED` | broker_ibkr | critical | Need re-authentication |
| `IBKR_FILL_TIMEOUT` | broker_ibkr | error | Order not filled in 40 min |
| `NEWS_QUOTA_EXHAUSTED` | trade_loop | warning | Newsdata.io daily limit hit |
| `VALIDATION_REJECTED` | trade_loop | warning | Claude decision failed validation |
