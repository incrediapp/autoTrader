# Firestore Schema
## Version: Production-Ready Spec v2

All collections are at the root level unless noted as subcollections.
Fields marked `[index]` require a Firestore composite index.
Fields marked `[TTL]` have a Firestore TTL policy configured on that field.
All timestamps are Firestore Timestamp (UTC). All monetary values are USD floats.

---

## Design Principles

1. **Denormalise for read performance.** Key metrics are duplicated on parent
   documents so dashboards load with a single document read.
2. **Subcollections for unbounded data.** Cycles, trades, and errors are
   subcollections — never arrays on parent documents.
3. **Counters via batch writes.** Denormalised counters (totalTrades, etc.) are
   incremented using Firestore transactions to prevent race conditions.
4. **Admin queries use collection group queries.** All subcollection documents
   include `userId` and `strategyId` denormalised so collection group queries work.
5. **Sensitive data never touches Firestore.** API keys, tokens, secrets — all in
   Google Cloud Secret Manager. Firestore only stores presence flags.
6. **Immutable financial records.** Trade documents are never updated after creation
   (except to add fill details from IBKR async fills). Cycle documents are immutable.
   Corrections are new documents, never overwrites.
7. **TTL policies for ephemeral data.** Short-lived data has a `expireAt` field with
   a Firestore TTL policy rather than manual cleanup.

---

## Collection: `users`

Document ID: Firebase Auth UID

```
users/{userId}

  // ── Identity ──────────────────────────────────────────────────────────────
  uid: string                          // same as document ID
  email: string
  emailVerified: boolean
  displayName: string
  photoUrl: string | null
  createdAt: timestamp
  lastActiveAt: timestamp              // updated on every app open
  lastSeenAppVersion: string           // e.g. "1.2.3"

  // ── Account status ────────────────────────────────────────────────────────
  status: 'active' | 'suspended' | 'deleted'
  suspendedAt: timestamp | null
  suspendedReason: string | null       // admin-entered reason
  role: 'user' | 'admin'

  // ── Onboarding state ──────────────────────────────────────────────────────
  onboarding: {
    completedSteps: string[]           // e.g. ['broker_connected', 'first_strategy']
    completedAt: timestamp | null
  }

  // ── Broker connections ────────────────────────────────────────────────────
  // Keys stored in Secret Manager. This block is metadata only.
  brokers: {
    binance: {
      connected: boolean
      connectedAt: timestamp | null
      lastVerifiedAt: timestamp | null // last time credentials were tested
      label: string | null             // user nickname e.g. "Main account"
      testnetEnabled: boolean          // true = paper mode uses testnet API
      lastErrorAt: timestamp | null
      lastErrorMessage: string | null
    }
    ibkr: {
      connected: boolean
      connectedAt: timestamp | null
      accountId: string | null         // IBKR account number (not sensitive)
      lastVerifiedAt: timestamp | null
      tokenExpiresAt: timestamp | null // surface expiry warning in UI
      label: string | null
      lastErrorAt: timestamp | null
      lastErrorMessage: string | null
    }
  }

  // ── Notification configuration ────────────────────────────────────────────
  notifications: {
    fcmTokens: string[]                // array — user may have multiple devices
    fcmTokensUpdatedAt: timestamp | null
    globalEnabled: boolean             // master off switch
    // Global defaults — overridden per strategy
    defaults: {
      onTrade: boolean
      onCycle: boolean                 // verbose mode — off by default
      onSignificant: boolean           // auto-pause, errors, broker issues
      onAssetSuggestion: boolean
      onStrategyFlaggedForReview: boolean
      dailySummary: boolean
      dailySummaryHourUtc: number      // 0-23, hour to send daily summary
      weeklySummary: boolean
    }
  }

  // ── Aggregate stats (denormalised, updated by Cloud Functions) ─────────────
  // Used by admin dashboard. Never updated by Flutter client.
  stats: {
    totalStrategies: number
    activeStrategies: number
    pausedStrategies: number
    archivedStrategies: number
    liveStrategies: number
    paperStrategies: number

    // Trades
    totalTrades: number                // live + paper
    totalLiveTrades: number
    totalPaperTrades: number
    totalTradeNotionalUsd: number      // sum of all executedNotionalUsd
    totalFeesUsd: number
    totalRealizedPnlUsd: number        // all closed live trades

    // Activity
    totalCycles: number
    lastTradeAt: timestamp | null
    lastCycleAt: timestamp | null

    // Claude costs (estimated)
    claudeApiCallsTotal: number
    claudeApiCostUsdTotal: number
    claudeApiCostUsdThisMonth: number
    claudeCostMonthReset: string       // YYYY-MM of current month bucket

    // Errors
    errorCountLast24h: number          // recomputed by daily stats function
    errorCountTotal: number
  }
```

---

## Subcollection: `users/{userId}/strategies`

Document ID: auto-generated (nanoid, 12 chars)

```
users/{userId}/strategies/{strategyId}

  // ── Identity ──────────────────────────────────────────────────────────────
  strategyId: string                   // denormalised (matches document ID)
  userId: string                       // denormalised for collection group queries
  name: string                         // user-chosen, max 50 chars
  description: string                  // original plain-English input, max 2000 chars
  descriptionHistory: [                // append-only, every version kept
    {
      text: string
      updatedAt: timestamp
      claudeSummary: string
    }
  ]

  // ── Claude interpretation ─────────────────────────────────────────────────
  claudeSummary: string                // current interpreted summary, shown to user
  interpretedAt: timestamp
  interpretedModelVersion: string      // e.g. "claude-haiku-4-5" — track model changes

  // ── Decision mode ─────────────────────────────────────────────────────────
  decisionMode: 'rule_interpreter' | 'autonomous_reasoner'
  decisionModeHistory: [               // append-only mode change log
    { mode: string, changedAt: timestamp }
  ]

  // ── Rules (rule_interpreter mode only) ────────────────────────────────────
  rules: [
    {
      ruleId: string                   // stable ID e.g. "rsi_buy_signal"
      condition: string                // DSL string, see claude-prompting.md
      action: string                   // DSL string, see claude-prompting.md
      priority: number                 // 1 = highest (evaluated first)
      active: boolean                  // can disable individual rules
      createdAt: timestamp
      lastTriggeredAt: timestamp | null
      triggerCount: number
    }
  ]

  // ── Assets ────────────────────────────────────────────────────────────────
  assets: {
    broker: 'binance' | 'ibkr'
    watchlist: string[]                // canonical symbols e.g. ["BTCUSDT", "ETHUSDT"]
    claudeSuggested: [                 // suggestions Claude has made
      {
        symbol: string
        reason: string
        suggestedAt: timestamp
        accepted: boolean | null       // null = pending user decision
        acceptedAt: timestamp | null
      }
    ]
  }

  // ── Risk parameters ───────────────────────────────────────────────────────
  risk: {
    maxLossPerTradePct: number         // e.g. 2.0 → max 2% of portfolio per trade
    maxDrawdownPct: number             // e.g. 15.0 → auto-pause at 15% from peak
    maxPositionSizePct: number         // e.g. 20.0 → max 20% in one asset
    maxOpenPositions: number           // e.g. 5
    minConfidenceToTrade: number       // 0–1, autonomous mode only (default 0.0 = disabled)
    stopLossPerTradePct: number | null // e.g. 3.0 → sell if position down 3%
    takeProfitPerTradePct: number | null // e.g. 8.0 → sell if position up 8%
  }

  // ── Execution state ───────────────────────────────────────────────────────
  mode: 'paper' | 'live'
  modeHistory: [                       // append-only
    { mode: string, changedAt: timestamp, changedByUserId: string }
  ]
  liveEnabledAt: timestamp | null      // first time live was ever activated
  paperStartedAt: timestamp            // when paper mode began (for 24h enforcement)

  status: 'active' | 'paused' | 'auto_paused' | 'archived'
  statusHistory: [                     // append-only
    { status: string, changedAt: timestamp, reason: string | null }
  ]
  pausedAt: timestamp | null
  autoPausedAt: timestamp | null
  autoPausedReason: string | null      // e.g. "max_drawdown_exceeded", "ibkr_auth_expired"
  archivedAt: timestamp | null

  // ── Broker health (per strategy) ──────────────────────────────────────────
  brokerHealth: {
    lastSuccessfulCycleAt: timestamp | null
    consecutiveFailures: number        // reset to 0 on any success
    brokerUnreachable: boolean         // set after 3 consecutive broker failures
    brokerUnreachableAt: timestamp | null
  }

  // ── Pending live trade (IBKR async fills) ────────────────────────────────
  pendingOrderIds: string[]            // broker order IDs awaiting fill confirmation

  // ── Schedule ──────────────────────────────────────────────────────────────
  schedule: {
    checkIntervalMinutes: number       // default 15, min 5, max 60
    activeHours: {
      enabled: boolean                 // false = run 24/7
      start: string                    // "HH:MM" UTC
      end: string                      // "HH:MM" UTC
      daysOfWeek: number[]             // [1,2,3,4,5] = Mon–Fri, [0..6] = all
      timezone: string                 // IANA e.g. "America/New_York"
    }
    priceThresholds: [                 // for event-driven triggers
      {
        thresholdId: string
        symbol: string
        triggerType: 'price' | 'rsi' | 'volume'
        direction: 'above' | 'below'
        value: number
        active: boolean
        lastTriggeredAt: timestamp | null
        cooldownMinutes: number        // min time between re-triggers, default 60
      }
    ]
  }

  // ── Notifications (overrides global defaults) ─────────────────────────────
  notifications: {
    useDefaults: boolean
    onTrade: boolean
    onCycle: boolean
    onSignificant: boolean
    onAssetSuggestion: boolean
    dailySummary: boolean
  }

  // ── Timestamps ────────────────────────────────────────────────────────────
  createdAt: timestamp
  updatedAt: timestamp
  lastCycleAt: timestamp | null
  lastCycleId: string | null
  lastTradeAt: timestamp | null
  lastTradeId: string | null

  // ── Strategy-level analytics (denormalised) ───────────────────────────────
  // Updated by Cloud Functions after each cycle/trade. Never by client.
  stats: {
    // Cycles
    totalCycles: number
    totalCyclesWithTrade: number
    totalCyclesWithError: number
    avgCycleDurationMs: number

    // Trades
    totalTrades: number
    totalLiveTrades: number
    totalPaperTrades: number
    openPositionsCount: number
    winCount: number                   // closed trades with positive P&L
    lossCount: number
    breakEvenCount: number
    totalRealizedPnlUsd: number
    totalFeesUsd: number
    totalTradeNotionalUsd: number
    largestWinUsd: number
    largestLossUsd: number
    avgWinUsd: number
    avgLossUsd: number
    profitFactor: number | null        // gross profit / gross loss

    // Drawdown
    peakPortfolioValueUsd: number      // for drawdown calculation
    currentDrawdownPct: number
    maxDrawdownPct: number             // historical worst
    maxDrawdownStartAt: timestamp | null
    maxDrawdownEndAt: timestamp | null  // null if still in drawdown

    // Risk-adjusted returns
    sharpeRatio: number | null
    sortinoRatio: number | null
    lastRiskMetricsComputedAt: timestamp | null

    // Claude costs
    claudeApiCalls: number
    claudeApiCostUsd: number
    claudeAvgCostPerCycleUsd: number
  }
```

---

## Subcollection: `users/{userId}/strategies/{strategyId}/cycles`

One document per trade-loop execution. Immutable after creation.
Document ID: `{timestamp_ms}_{nanoid_6}` — sortable by time, unique.

```
users/{userId}/strategies/{strategyId}/cycles/{cycleId}

  // ── Identity ──────────────────────────────────────────────────────────────
  cycleId: string
  strategyId: string                   // denormalised
  userId: string                       // denormalised

  // ── Trigger ───────────────────────────────────────────────────────────────
  triggeredBy: 'schedule' | 'price_event' | 'manual'
  priceEventId: string | null          // if triggeredBy == 'price_event'

  // ── Timing ────────────────────────────────────────────────────────────────
  startedAt: timestamp
  completedAt: timestamp | null
  durationMs: number | null
  phases: {                            // timing breakdown for performance monitoring
    marketDataMs: number | null
    indicatorsMs: number | null
    claudeMs: number | null
    validationMs: number | null
    executionMs: number | null
    loggingMs: number | null
  }

  // ── Market snapshot ───────────────────────────────────────────────────────
  marketSnapshot: {
    fetchedAt: timestamp
    dataFreshnessMs: number            // age of newest candle at time of fetch
    dataStale: boolean                 // true if newest candle > 20 min old
    assets: [
      {
        symbol: string
        price: number
        open24h: number
        high24h: number
        low24h: number
        close24h: number
        volume24h: number
        priceChangePct24h: number
        // Indicators
        rsi14: number | null
        macdLine: number | null
        macdSignal: number | null
        macdHistogram: number | null
        ema20: number | null
        ema50: number | null
        ema200: number | null
        // Bollinger Bands
        bbUpper: number | null
        bbMiddle: number | null
        bbLower: number | null
        // ATR for position sizing
        atr14: number | null
        // Candle count used for indicator calculation
        candlesUsed: number
      }
    ]
    fearGreedIndex: number | null
    fearGreedLabel: string | null
    fearGreedCachedAt: timestamp | null
    newsHeadlines: string[] | null
    newsFetchedAt: timestamp | null
    newsSkipped: boolean               // true if quota exhausted or API down
    newsSkipReason: string | null
  }

  // ── Portfolio snapshot ────────────────────────────────────────────────────
  portfolioSnapshot: {
    fetchedAt: timestamp
    broker: 'binance' | 'ibkr'
    totalValueUsd: number
    cashUsd: number
    positions: [
      {
        symbol: string
        quantity: number
        avgCostUsd: number
        currentPriceUsd: number
        currentValueUsd: number
        unrealizedPnlUsd: number
        unrealizedPnlPct: number
        openingTradeId: string | null  // link to the buy trade that opened this
      }
    ]
  }

  // ── Drawdown check ────────────────────────────────────────────────────────
  drawdownCheck: {
    peakValueUsd: number
    currentValueUsd: number
    currentDrawdownPct: number
    limitPct: number
    breached: boolean
  }

  // ── Claude interaction ────────────────────────────────────────────────────
  claudeCalled: boolean
  claudeMode: 'rule_interpreter' | 'autonomous_reasoner' | null
  claudeModel: string | null           // e.g. "claude-haiku-4-5"
  claudePromptTokens: number | null
  claudeCompletionTokens: number | null
  claudeCostUsd: number | null
  claudeLatencyMs: number | null
  claudeRawResponse: string | null     // full JSON string — for debugging
  claudeParseSuccess: boolean | null
  claudeParseError: string | null

  // ── Rule evaluation (rule_interpreter mode) ───────────────────────────────
  rulesEvaluated: number | null        // how many rules were checked
  rulesTriggered: string[] | null      // ruleIds that evaluated to true

  // ── Decision ─────────────────────────────────────────────────────────────
  decision: {
    action: 'buy' | 'sell' | 'hold' | 'suggest_asset' | 'skip' | 'error'
    symbol: string | null
    side: 'buy' | 'sell' | null
    requestedNotionalUsd: number | null
    reasoning: string | null
    confidence: number | null          // 0–1, autonomous mode only
    suggestedAsset: string | null
    suggestedAssetReasoning: string | null
    flagForReview: boolean
    flagReason: string | null
    // Validation overrides
    validationApplied: boolean
    validationNotes: string[] | null   // e.g. ["notional clamped to max position size"]
  }

  // ── Execution ─────────────────────────────────────────────────────────────
  tradeExecuted: boolean
  tradeId: string | null
  skippedReason: string | null         // why no trade if action was buy/sell

  // ── Stop/Take profit checks ───────────────────────────────────────────────
  stopLossChecks: [                    // checked for each open position each cycle
    {
      symbol: string
      currentPnlPct: number
      stopLossPct: number
      triggered: boolean
      tradeId: string | null           // stop-loss trade if triggered
    }
  ]
  takeProfitChecks: [
    {
      symbol: string
      currentPnlPct: number
      takeProfitPct: number
      triggered: boolean
      tradeId: string | null
    }
  ]

  // ── Errors ────────────────────────────────────────────────────────────────
  error: boolean
  errorSource: 'market_data' | 'indicators' | 'claude_api' | 'validation'
             | 'broker_api' | 'logging' | 'unknown' | null
  errorMessage: string | null
  errorCode: string | null
  errorRetryable: boolean | null

  // ── TTL ───────────────────────────────────────────────────────────────────
  expireAt: timestamp                  // [TTL] createdAt + 90 days

  // [index] userId ASC, strategyId ASC, startedAt DESC
  // [index] userId ASC, tradeExecuted ASC, startedAt DESC
  // [index] userId ASC, error ASC, startedAt DESC
```

---

## Subcollection: `users/{userId}/strategies/{strategyId}/trades`

Immutable financial records. Never deleted (live trades: 7 years). Paper trades: 1 year TTL.
Document ID: `{timestamp_ms}_{nanoid_6}`

```
users/{userId}/strategies/{strategyId}/trades/{tradeId}

  // ── Identity ──────────────────────────────────────────────────────────────
  tradeId: string
  strategyId: string                   // denormalised
  userId: string                       // denormalised
  cycleId: string                      // cycle that generated this trade

  // ── Trade classification ──────────────────────────────────────────────────
  broker: 'binance' | 'ibkr'
  symbol: string                       // canonical e.g. "BTCUSDT" or "AAPL"
  assetClass: 'crypto' | 'stock' | 'etf'
  side: 'buy' | 'sell'
  mode: 'paper' | 'live'
  source: 'strategy' | 'stop_loss' | 'take_profit' | 'emergency' | 'manual'

  // ── Order details ─────────────────────────────────────────────────────────
  orderType: 'market' | 'limit'
  requestedNotionalUsd: number         // what Claude/rules asked for
  requestedQuantity: number | null     // if specified by quantity instead

  // ── Execution (filled in after broker confirms) ────────────────────────────
  executedQuantity: number
  executedPriceUsd: number
  executedNotionalUsd: number          // executedQuantity * executedPriceUsd
  slippageUsd: number | null           // executedPrice vs requestedPrice difference
  feeUsd: number
  feeCurrency: string
  feeAsset: string | null              // e.g. "BNB" if Binance uses BNB fee discount

  // ── Broker tracking ───────────────────────────────────────────────────────
  brokerOrderId: string | null
  brokerStatus: 'filled' | 'partial' | 'rejected' | 'simulated' | 'pending_fill'
  brokerRawResponse: string | null     // JSON string, for debugging
  fillConfirmedAt: timestamp | null    // when async fill was confirmed (IBKR)

  // ── Position linkage ──────────────────────────────────────────────────────
  isOpeningTrade: boolean              // true = opens/adds to a position
  isClosingTrade: boolean              // true = reduces/closes a position
  openingTradeIds: string[]            // buy trades this sell is closing (FIFO)

  // ── P&L (populated only for closing trades) ───────────────────────────────
  realizedPnlUsd: number | null
  realizedPnlPct: number | null
  holdingPeriodMs: number | null

  // ── Tax fields ────────────────────────────────────────────────────────────
  // Israeli accountant / general FIFO cost basis
  costBasisUsd: number | null          // for sells: FIFO cost basis of closed qty
  proceedsUsd: number | null           // for sells: gross proceeds (before fees)
  netProceedsUsd: number | null        // proceedsUsd - feeUsd
  acquisitionDate: timestamp | null    // date of the matching buy (for holding period)
  isShortTermGain: boolean | null      // held < 1 year

  // ── Claude context ────────────────────────────────────────────────────────
  claudeReasoning: string              // copied from cycle for easy trade-level access
  claudeConfidence: number | null
  claudeMode: 'rule_interpreter' | 'autonomous_reasoner'
  rulesTriggered: string[] | null

  // ── Timestamps ────────────────────────────────────────────────────────────
  requestedAt: timestamp
  submittedAt: timestamp | null        // when order was sent to broker
  executedAt: timestamp                // confirmed fill time (or simulation time)

  // ── TTL (paper only) ─────────────────────────────────────────────────────
  expireAt: timestamp | null           // [TTL] paper trades only: createdAt + 365 days

  // [index] userId ASC, executedAt DESC
  // [index] userId ASC, symbol ASC, executedAt DESC
  // [index] userId ASC, mode ASC, executedAt DESC
  // [index] userId ASC, side ASC, executedAt DESC
  // [index] userId ASC, source ASC, executedAt DESC
  // [index] strategyId ASC, executedAt DESC (for strategy-scoped queries)
```

---

## Subcollection: `users/{userId}/strategies/{strategyId}/positions`

Current open positions, updated after each trade. One document per symbol.
This is derived/cached state — source of truth is the broker.

```
users/{userId}/strategies/{strategyId}/positions/{symbol}

  symbol: string
  strategyId: string                   // denormalised
  userId: string                       // denormalised
  broker: 'binance' | 'ibkr'

  // Current state
  quantity: number
  avgCostUsd: number                   // FIFO weighted average
  totalCostBasisUsd: number            // avgCostUsd * quantity
  currentPriceUsd: number              // updated each cycle
  currentValueUsd: number
  unrealizedPnlUsd: number
  unrealizedPnlPct: number

  // Constituent buy trades (FIFO queue for tax)
  lotsFIFO: [
    {
      tradeId: string
      quantity: number
      costPerUnit: number
      acquiredAt: timestamp
      remainingQty: number             // reduced as sells close this lot
    }
  ]

  // Timestamps
  openedAt: timestamp                  // first buy
  lastUpdatedAt: timestamp
```

---

## Collection: `priceEvents`

Event-driven trigger documents. Written by `priceMonitor`, read by `tradeLoopOnPriceEvent`.
Document ID: `{userId}_{strategyId}_{symbol}_{thresholdId}` — one per threshold,
prevents duplicate triggers for the same condition.

```
priceEvents/{eventId}

  userId: string
  strategyId: string
  symbol: string
  thresholdId: string
  triggerType: 'price' | 'rsi' | 'volume'
  direction: 'above' | 'below'
  currentValue: number
  thresholdValue: number
  detectedAt: timestamp
  processed: boolean
  processedAt: timestamp | null
  tradeLoopCycleId: string | null      // cycle this triggered

  expireAt: timestamp                  // [TTL] 24 hours after detectedAt
```

---

## Collection: `idempotencyKeys`

Guards against duplicate live order placement on Cloud Function retry.

```
idempotencyKeys/{key}
  // key format: {strategyId}_{cycleId}_{side}_{symbol}

  strategyId: string
  cycleId: string
  userId: string
  side: string
  symbol: string
  brokerOrderId: string | null         // filled in after successful order
  createdAt: timestamp

  expireAt: timestamp                  // [TTL] createdAt + 24 hours
```

---

## Collection: `ibkrPendingFills`

IBKR orders placed but not yet fill-confirmed (async fill process).
Polled by `ibkrFillPoller` every 2 minutes.

```
ibkrPendingFills/{pendingId}

  userId: string
  strategyId: string
  tradeId: string
  brokerOrderId: string
  symbol: string
  side: string
  submittedAt: timestamp
  lastCheckedAt: timestamp | null
  checkCount: number
  status: 'pending' | 'filled' | 'failed' | 'timeout'
  resolvedAt: timestamp | null

  expireAt: timestamp                  // [TTL] 24 hours — if not filled in 24h, flag as timeout
```

---

## Collection: `ibkrConidCache`

Ticker → IBKR contract ID mapping. Refreshed if older than 7 days.

```
ibkrConidCache/{symbol}

  symbol: string
  conid: number
  exchange: string
  currency: string
  secType: string                      // 'STK', 'ETF', etc.
  cachedAt: timestamp

  expireAt: timestamp                  // [TTL] cachedAt + 7 days
```

---

## Collection: `marketDataCache`

Shared market data cache across all strategies, keyed by symbol + interval.
Prevents multiple strategies watching the same asset from making duplicate API calls.

```
marketDataCache/{symbol}_{interval}

  symbol: string
  interval: string                     // e.g. "15m"
  broker: 'binance' | 'ibkr'
  candles: [                           // last 200 candles
    { t: number, o: number, h: number, l: number, c: number, v: number }
  ]
  fetchedAt: timestamp
  nextFetchAllowedAt: timestamp        // rate-limit guard

  expireAt: timestamp                  // [TTL] fetchedAt + 20 minutes
```

---

## Collection: `externalDataCache`

```
// Fear & Greed
externalDataCache/fearGreed
  value: number
  label: string
  fetchedAt: timestamp
  expireAt: timestamp                  // [TTL] + 1 hour

// News per symbol group (key = sorted symbols joined by "_")
externalDataCache/news_{symbolKey}
  headlines: string[]
  fetchedAt: timestamp
  symbolKey: string
  expireAt: timestamp                  // [TTL] + 30 minutes

// Newsdata.io quota tracker
externalDataCache/newsdataQuota
  callsToday: number
  quotaLimit: number                   // 200 for free tier
  dayReset: string                     // YYYY-MM-DD
  lastCallAt: timestamp
  quotaExhausted: boolean
```

---

## Collection: `systemMetrics`

Admin dashboard data. Never queried by user-facing Flutter app.

```
// Live rolling metrics (updated continuously by Cloud Functions)
systemMetrics/current
  updatedAt: timestamp

  // Users
  totalUsers: number
  activeUsersLast24h: number
  activeUsersLast7d: number
  newUsersToday: number
  newUsersThisWeek: number

  // Strategies
  totalStrategies: number
  activeStrategies: number
  liveStrategies: number
  paperStrategies: number
  pausedStrategies: number
  autoPausedStrategies: number

  // Cycles (rolling today = UTC day)
  cyclesToday: number
  cyclesThisWeek: number
  cyclesTotal: number
  avgCycleDurationMsToday: number
  errorCyclesToday: number
  errorRatePctToday: number

  // Trades (today)
  tradesToday: number
  liveTradesToday: number
  paperTradesToday: number
  notionalVolumeUsdToday: number
  feesUsdToday: number

  // Claude
  claudeCallsToday: number
  claudeCostUsdToday: number
  claudeCostUsdThisMonth: number
  claudeAvgLatencyMsToday: number
  claudeErrorsToday: number

  // Brokers
  binanceApiCallsToday: number
  binanceApiErrorsToday: number
  ibkrApiCallsToday: number
  ibkrApiErrorsToday: number

  // Notifications
  fcmSentToday: number
  fcmFailedToday: number

// Daily snapshots (same fields + date string)
systemMetrics/{YYYY-MM-DD}
  date: string
  // all fields from current, captured at end of day
```

---

## Collection: `errorLogs`

All Cloud Function errors. Written only by Cloud Functions (service account).
Never deleted — TTL after 1 year.

```
errorLogs/{errorId}

  errorId: string
  userId: string | null
  strategyId: string | null
  cycleId: string | null
  tradeId: string | null

  source: 'trade_loop' | 'strategy_setup' | 'broker_binance' | 'broker_ibkr'
        | 'claude_api' | 'price_monitor' | 'notification' | 'fill_poller'
        | 'stats_compute' | 'emergency_sell' | 'auth'
  severity: 'warning' | 'error' | 'critical'

  // Error details
  message: string
  errorCode: string | null             // structured code e.g. "BINANCE_INSUFFICIENT_BALANCE"
  stack: string | null
  retryable: boolean
  metadata: map                        // arbitrary extra context, sanitised (no secrets)

  // Resolution
  occurredAt: timestamp
  resolved: boolean
  resolvedAt: timestamp | null
  resolvedByAdminId: string | null
  resolutionNote: string | null

  // Alert tracking
  alertSent: boolean                   // whether admin was notified of this error
  alertSentAt: timestamp | null

  expireAt: timestamp                  // [TTL] occurredAt + 365 days

  // [index] occurredAt DESC
  // [index] userId ASC, occurredAt DESC
  // [index] source ASC, severity ASC, occurredAt DESC
  // [index] resolved ASC, severity ASC, occurredAt DESC
```

---

## Collection: `adminAuditLog`

Append-only. Written by Cloud Functions only. Never updated or deleted.

```
adminAuditLog/{auditId}

  adminUserId: string
  adminEmail: string                   // denormalised snapshot
  action: string                       // e.g. "suspend_user" "resolve_error" "promote_admin"
  targetType: 'user' | 'strategy' | 'error' | 'system'
  targetId: string
  before: map | null                   // document state before change
  after: map | null                    // document state after change
  ipAddress: string | null             // from Cloud Function request context
  userAgent: string | null
  performedAt: timestamp
```

---

## Firestore Security Rules (Complete)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper functions
    function isAuth() {
      return request.auth != null;
    }

    function isOwner(userId) {
      return isAuth() && request.auth.uid == userId;
    }

    function isAdmin() {
      return isAuth() &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }

    function isServiceAccount() {
      // Cloud Functions use a service account — identified by not being a user token
      return request.auth.token.firebase.sign_in_provider == 'google.com' &&
             request.auth.token.email.matches('.*@.*\\.iam\\.gserviceaccount\\.com');
    }

    // Users: owner read/write, admin read, service account write for stats
    match /users/{userId} {
      allow read: if isOwner(userId) || isAdmin();
      allow create: if isOwner(userId);
      // Users cannot write stats, role, or status from client
      allow update: if isOwner(userId) &&
        !request.resource.data.diff(resource.data).affectedKeys()
          .hasAny(['stats', 'role', 'status', 'suspendedAt', 'suspendedReason']);

      match /strategies/{strategyId} {
        allow read: if isOwner(userId) || isAdmin();
        allow create: if isOwner(userId);
        // Users cannot update stats, statusHistory, modeHistory, or liveEnabledAt from client
        allow update: if isOwner(userId) &&
          !request.resource.data.diff(resource.data).affectedKeys()
            .hasAny(['stats', 'statusHistory', 'modeHistory', 'liveEnabledAt']);
        allow delete: if false; // never delete — archive instead

        match /cycles/{cycleId} {
          allow read: if isOwner(userId) || isAdmin();
          allow write: if false; // Cloud Functions only
        }

        match /trades/{tradeId} {
          allow read: if isOwner(userId) || isAdmin();
          allow write: if false; // Cloud Functions only
        }

        match /positions/{symbol} {
          allow read: if isOwner(userId) || isAdmin();
          allow write: if false; // Cloud Functions only
        }
      }
    }

    // System collections: service account write only, admin read only
    match /systemMetrics/{docId} {
      allow read: if isAdmin();
      allow write: if false; // Cloud Functions only via Admin SDK
    }

    match /errorLogs/{errorId} {
      allow read: if isAdmin();
      allow update: if isAdmin() &&
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['resolved', 'resolvedAt', 'resolvedByAdminId', 'resolutionNote']);
      allow create, delete: if false;
    }

    match /adminAuditLog/{auditId} {
      allow read: if isAdmin();
      allow write: if false; // Cloud Functions only
    }

    match /priceEvents/{eventId} {
      allow read: if false; // internal only
      allow write: if false;
    }

    match /idempotencyKeys/{key} {
      allow read, write: if false;
    }

    match /ibkrPendingFills/{pendingId} {
      allow read, write: if false;
    }

    match /ibkrConidCache/{symbol} {
      allow read, write: if false;
    }

    match /marketDataCache/{cacheId} {
      allow read, write: if false;
    }

    match /externalDataCache/{cacheId} {
      allow read, write: if false;
    }
  }
}
```

---

## Complete Index List

```
// cycles subcollection (collection group)
collectionGroup: cycles
  userId ASC, startedAt DESC
  userId ASC, tradeExecuted ASC, startedAt DESC
  userId ASC, error ASC, startedAt DESC
  userId ASC, strategyId ASC, startedAt DESC

// trades subcollection (collection group)
collectionGroup: trades
  userId ASC, executedAt DESC
  userId ASC, symbol ASC, executedAt DESC
  userId ASC, mode ASC, executedAt DESC
  userId ASC, side ASC, executedAt DESC
  userId ASC, source ASC, executedAt DESC
  strategyId ASC, executedAt DESC

// strategies subcollection (collection group)
collectionGroup: strategies
  status ASC, mode ASC                          // trade loop: all active strategies
  userId ASC, status ASC, createdAt DESC        // user strategy list

// errorLogs
collection: errorLogs
  occurredAt DESC
  userId ASC, occurredAt DESC
  source ASC, severity ASC, occurredAt DESC
  resolved ASC, severity ASC, occurredAt DESC

// priceEvents
collection: priceEvents
  processed ASC, detectedAt DESC               // find unprocessed events
```

---

## Firestore Quota and Cost Notes

With one user, 20 active strategies, 24/7 crypto:
- Cycles written per day: 96/cycle × 20 strategies = 1,920 documents/day
- Reads per cycle: ~8 per strategy = 153,600 reads/day
- Writes per cycle: ~3 per strategy = 57,600 writes/day

Firebase Spark (free): 50K reads/day, 20K writes/day → **insufficient**
Firebase Blaze pay-as-you-go:
  - Reads: $0.06/100K → ~$0.09/day
  - Writes: $0.18/100K → ~$0.10/day
  - Estimated Firestore cost: **~$6/month** at 20 active strategies

Set up GCP budget alerts at $10, $20, $50/month.
