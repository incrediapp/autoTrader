# Implementation Order
## Version: Production-Ready Spec v1

---

## How to Use This Document

Hand this to Cursor alongside the other spec files. Each task references which
spec file contains the full detail. Work strictly in order — later tasks depend
on earlier ones. Never skip a task to come back to it — partial implementations
cause hard-to-debug integration failures in financial systems.

Each task has an estimated complexity: S (< 2h), M (2–4h), L (4–8h), XL (> 8h).

---

## Phase 0: Project Setup (do this before any code)

### 0.1 Firebase Project [S]
- Create Firebase project in GCP Console
- Enable Firestore (native mode, region: `europe-west1` — closest to Israel)
- Enable Firebase Auth (email/password provider only)
- Enable Firebase Cloud Messaging
- Enable Cloud Functions (v2)
- Enable Cloud Scheduler
- Enable Google Cloud Secret Manager
- Enable Google Cloud Monitoring
- Switch to Blaze plan (required for external network calls from Cloud Functions)

### 0.2 GCP Billing and Budgets [S]
- Set up billing alerts: $10 / $25 / $50 / $100 monthly
- Enable Cost Management dashboard
- Tag all resources with `project: ai-trader`

### 0.3 Repository Structure [S]
```
ai-trader/
├── functions/              Cloud Functions (Node.js 20)
│   ├── src/
│   │   ├── tradeLoop/
│   │   │   ├── scheduled.js
│   │   │   ├── eventDriven.js
│   │   │   ├── strategyRunner.js
│   │   │   ├── marketData.js
│   │   │   ├── indicators.js
│   │   │   └── validation.js
│   │   ├── brokers/
│   │   │   ├── adapter.js
│   │   │   ├── binance.js
│   │   │   └── ibkr.js
│   │   ├── claude/
│   │   │   ├── client.js
│   │   │   ├── prompts.js
│   │   │   └── parser.js
│   │   ├── positions/
│   │   │   └── fifo.js
│   │   ├── notifications/
│   │   │   └── fcm.js
│   │   ├── monitoring/
│   │   │   ├── logger.js
│   │   │   ├── metrics.js
│   │   │   └── errors.js
│   │   ├── strategy/
│   │   │   ├── setup.js
│   │   │   └── rules.js
│   │   ├── admin/
│   │   │   └── stats.js
│   │   └── utils/
│   │       ├── secrets.js
│   │       ├── rateLimit.js
│   │       ├── idempotency.js
│   │       └── sanitise.js
│   ├── index.js            Function exports
│   └── package.json
│
├── flutter_app/            Flutter application
│   ├── lib/
│   │   ├── main.dart
│   │   ├── app/
│   │   │   ├── router.dart
│   │   │   └── theme.dart
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── onboarding/
│   │   │   ├── dashboard/
│   │   │   ├── strategy/
│   │   │   ├── analytics/
│   │   │   ├── notifications/
│   │   │   ├── settings/
│   │   │   └── admin/
│   │   ├── shared/
│   │   │   ├── widgets/
│   │   │   ├── models/
│   │   │   └── providers/
│   │   └── services/
│   │       └── cloud_functions.dart
│   └── pubspec.yaml
│
├── firestore.rules
├── firestore.indexes.json
└── firebase.json
```

### 0.4 Environment Configuration [S]
- `.env.local` for local development (not committed)
- Production config via Secret Manager only
- Firebase emulator suite for local development:
  `firebase emulators:start --only functions,firestore,auth`

### 0.5 npm Packages [S]
```json
{
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^5.0.0",
    "@google-cloud/secret-manager": "^5.0.0",
    "@google-cloud/monitoring": "^4.0.0",
    "technicalindicators": "^3.1.0",
    "zod": "^3.22.0",
    "nanoid": "^3.3.7",
    "p-limit": "^3.1.0",
    "node-fetch": "^3.3.2"
  }
}
```

---

## Phase 1: Data Foundation

### 1.1 Firestore Security Rules [M]
File: `firestore.rules`
Spec: 02-firestore-schema.md → "Firestore Security Rules"

Implement all rules. Test with Firebase emulator using the Rules Playground.
Key rules to verify:
- User can read/write own strategies
- User cannot write to cycles or trades directly
- User cannot modify stats fields
- Admin can read everything
- Service account (Cloud Functions) bypasses rules via Admin SDK

### 1.2 Firestore Indexes [S]
File: `firestore.indexes.json`
Spec: 02-firestore-schema.md → "Complete Index List"

Deploy all composite indexes before any data is written.
Run `firebase deploy --only firestore:indexes` and wait for indexes to build.

### 1.3 Firestore TTL Policies [S]
Configure TTL policies in GCP Console → Firestore → TTL:
- `cycles` collection: field `expireAt`
- `trades` collection: field `expireAt` (paper trades only — live trades never have expireAt)
- `priceEvents` collection: field `expireAt`
- `idempotencyKeys` collection: field `expireAt`
- `ibkrPendingFills` collection: field `expireAt`
- `errorLogs` collection: field `expireAt`
- `externalDataCache` collections: field `expireAt`

### 1.4 Data Models (Flutter) [M]
Directory: `flutter_app/lib/shared/models/`

Create Dart model classes with `fromDoc()` factory and `toJson()` for:
- `UserModel` (from `users` collection)
- `StrategyModel` (from `strategies` subcollection)
- `CycleModel` (from `cycles` subcollection)
- `TradeModel` (from `trades` subcollection)
- `PositionModel` (from `positions` subcollection)
- `SystemMetrics` (from `systemMetrics/current`)
- `ErrorLogModel` (from `errorLogs`)

Use `freezed` package for immutable models with copyWith.

---

## Phase 2: Infrastructure Utilities (Cloud Functions)

Build these utilities before any business logic — everything else depends on them.

### 2.1 Structured Logger [S]
File: `functions/src/monitoring/logger.js`
Spec: 08-monitoring.md → "Structured Logging in Cloud Functions"

Implement: `logInfo`, `logWarn`, `logError`, `logCycleSummary`,
`logBrokerCall`, `logClaudeCall`, `PerformanceTimer`

### 2.2 Error Logger (Firestore) [S]
File: `functions/src/monitoring/errors.js`
Spec: 08-monitoring.md → "Application-Level Error Logging"

Implement: `logError()` function that writes to `errorLogs` collection
and sends FCM alert for critical errors.

### 2.3 Secret Manager Client [S]
File: `functions/src/utils/secrets.js`
Spec: 06-broker-integration.md → "Secret Management"

Implement: `getSecret()` with in-memory cache, `storeSecret()`, masked logging.

### 2.4 Idempotency Key Manager [S]
File: `functions/src/utils/idempotency.js`
Spec: 03-trade-loop.md → idempotency pattern

Implement: `checkIdempotencyKey()`, `writeIdempotencyKey()` with TTL.

### 2.5 Rate Limiter [S]
File: `functions/src/utils/rateLimit.js`
Spec: 03-trade-loop.md → "Rate Limiting on HTTPS Callable Functions"

Implement: `enforceRateLimit(userId, action, maxCalls, windowSeconds)`

### 2.6 Input Sanitiser [S]
File: `functions/src/utils/sanitise.js`
Spec: 04-claude-prompting.md → "Prompt Injection Defense"
Spec: 07-security.md → Layer 5

Implement: `sanitiseForPrompt()`, `maskSecrets()`, `sanitiseMetadata()`

### 2.7 System Metrics Updater [S]
File: `functions/src/monitoring/metrics.js`
Spec: 08-monitoring.md → "systemMetrics Real-Time Counters"

Implement: `incrementSystemMetric()`, `writeMetric()` (Cloud Monitoring)

---

## Phase 3: Broker Adapters

### 3.1 Broker Adapter Interface [S]
File: `functions/src/brokers/adapter.js`
Spec: 06-broker-integration.md → "Unified Broker Adapter"

Define the interface. Create the factory function `getBrokerAdapter()`.

### 3.2 Binance Adapter — Paper Mode Only First [L]
File: `functions/src/brokers/binance.js`
Spec: 06-broker-integration.md → "Binance Integration"

Implement in this order:
1. `binanceRequest()` with HMAC signing and retry logic
2. `ping()` — connection test
3. `fetchBinanceOHLCV()` — public endpoint, no auth
4. `getSpotPrice()` — public endpoint
5. `fetchBinancePortfolio()` — account balances
6. `placeBinanceOrder()` — testnet ONLY at this stage
7. Exchange info cache (LOT_SIZE filters)

Test against Binance testnet before touching live credentials.

### 3.3 Technical Indicators [S]
File: `functions/src/tradeLoop/indicators.js`
Spec: 06-broker-integration.md → "Technical Indicators"

Install `technicalindicators` package.
Implement: `computeAllIndicators(candles)` returning all indicators from spec.
Write unit tests for edge cases: insufficient candles, all-same-price candles.

### 3.4 Market Data Cache [S]
File: `functions/src/tradeLoop/marketData.js`
Spec: 02-firestore-schema.md → `marketDataCache` collection

Implement the shared cache layer: check Firestore cache, fetch if stale,
write back. This prevents N strategies all fetching the same OHLCV simultaneously.

### 3.5 External Data (Fear & Greed, News) [M]
File: `functions/src/tradeLoop/marketData.js`
Spec: 06-broker-integration.md → "External Data APIs"

Implement:
- `fetchFearGreedCached()` with 1-hour Firestore cache
- `fetchNewsCached()` with 30-min cache and quota tracking
- `enrichWithExternalData()` that handles both failing gracefully

### 3.6 IBKR Adapter [XL]
File: `functions/src/brokers/ibkr.js`
Spec: 06-broker-integration.md → "Interactive Brokers Integration"

Implement in this order:
1. OAuth token refresh logic (`getValidIBKRToken`, `refreshIBKRToken`)
2. `ibkrRequest()` wrapper with retry on 401
3. `resolveConid()` with Firestore cache
4. `fetchIBKRPortfolio()`
5. `fetchIBKROHLCV()`
6. `placeIBKROrder()` with two-step confirmation handling
7. `getIBKROrderStatus()` for fill poller
8. Market hours check (`isMarketOpen()`)

This is the most complex broker. Test every method in isolation before integration.

---

## Phase 4: Claude Integration

### 4.1 Claude API Client [S]
File: `functions/src/claude/client.js`
Spec: 04-claude-prompting.md → `callClaude()` function

Implement with:
- 30-second timeout
- Retry on 529/503 (max 2 retries, exponential backoff)
- Structured logging of every call (tokens, cost, latency)
- Model config: temperature=0, max_tokens=1024

### 4.2 JSON Parser and Validator [S]
File: `functions/src/claude/parser.js`
Spec: 04-claude-prompting.md → "JSON Parse and Validation"

Implement `parseClaudeJSON()` with:
- Markdown fence stripping
- JSON extraction fallback
- Zod schema validation
- All schemas: autonomous decision, rule reasoning, strategy setup

### 4.3 Prompt Builder [M]
File: `functions/src/claude/prompts.js`
Spec: 04-claude-prompting.md → all prompt sections

Implement:
- `buildStrategySetupPrompt(description, decisionMode, history)`
- `buildRuleReasoningPrompt(rule, triggered, market, portfolio, strategy)`
- `buildAutonomousPrompt(strategy, portfolio, market)`
- `buildDailySummaryPrompt(stats)`
- `formatMarketDataCompact(snapshot, symbol)`
- Market data formatter helpers

Prompt version constants at top of file.

### 4.4 Rule Condition Evaluator [M]
File: `functions/src/strategy/rules.js`
Spec: 04-claude-prompting.md → Rule DSL section

Implement `evaluateCondition(conditionString, market, portfolio)`:
- Parse the DSL condition string
- Map variable names to real values from market/portfolio snapshots
- Support: <, >, <=, >=, ==, !=, AND, OR, NOT, parentheses
- Return boolean
- Test with known conditions and known market data

This is pure logic — write comprehensive unit tests before integration.

---

## Phase 5: Core Trade Loop

### 5.1 Decision Validator [M]
File: `functions/src/tradeLoop/validation.js`
Spec: 03-trade-loop.md → "Phase 7: Decision Validation"

Implement `validateDecision(decision, strategy, portfolio)` with all 8 checks.
Write unit tests for every check — this is the last safety gate before real money.

### 5.2 Position Manager (FIFO) [M]
File: `functions/src/positions/fifo.js`
Spec: 06-broker-integration.md → "Position Management: FIFO Cost Basis"

Implement `updatePositionAfterTrade()` as a Firestore transaction.
Tests: open position, add to position, partial close, full close, close multiple lots.

### 5.3 Paper Trade Execution [M]
File: `functions/src/tradeLoop/strategyRunner.js`
Spec: 03-trade-loop.md → "Phase 8: Execute or Simulate" — paper path only

Implement the paper execution path: fetch spot price, create trade document,
call position manager. At this stage: paper only.

### 5.4 Stop-Loss / Take-Profit Checker [M]
File: `functions/src/tradeLoop/strategyRunner.js`
Spec: 03-trade-loop.md → "Stop-Loss and Take-Profit Checker"

Implement `checkStopLossAndTakeProfit()`. This runs before Claude each cycle.

### 5.5 Drawdown Checker [S]
File: `functions/src/tradeLoop/strategyRunner.js`
Spec: 03-trade-loop.md → Phase 2 of `runStrategyLoop`

Implement `checkDrawdown()` and `autoPauseStrategy()`.

### 5.6 Full Strategy Runner (paper) [L]
File: `functions/src/tradeLoop/strategyRunner.js`
Spec: 03-trade-loop.md → `runStrategyLoop`

Wire all phases together in the paper path.
Create the cycle document before starting.
Complete cycle document at end regardless of outcome.
Update strategy stats.

### 5.7 Scheduled Trade Loop [M]
File: `functions/src/tradeLoop/scheduled.js`
Spec: 03-trade-loop.md → `tradeLoopScheduled`

Wire the scheduler: load all active strategies, filter by active hours,
run with p-limit concurrency control, log summary.

Test with Firebase emulator: manually trigger the function with test strategies.

### 5.8 End-to-End Paper Test [L]
Create a real Binance testnet account.
Create a test strategy in Firestore manually.
Run the scheduler function locally (Firebase emulator or deployed).
Verify:
- Cycle document created correctly
- Market data fetched and indicators computed
- Claude called and response logged
- Paper trade created (no real money)
- Position updated in Firestore
- Strategy stats updated

Do not proceed to live until this works reliably for 24 hours.

---

## Phase 6: Cloud Functions — Supporting Functions

### 6.1 Strategy Setup Callable [M]
File: `functions/src/strategy/setup.js`
Spec: 04-claude-prompting.md → Strategy Setup Prompt
Spec: 03-trade-loop.md → `strategySetup` function

Multi-turn chat handler: call Claude, detect if clarification needed,
return questions or final config. Save strategy to Firestore on success.

### 6.2 Emergency Sell Callable [M]
File: `functions/src/tradeLoop/scheduled.js`
Spec: 03-trade-loop.md → `emergencySellAll`

Implement with:
- Immediate pause of all active strategies
- Promise.allSettled (never let one failure stop others)
- Per-position error logging
- Rate limit: 1 call per minute per user

### 6.3 Toggle Strategy Status Callable [S]
Spec: 03-trade-loop.md → `toggleStrategyStatus`

Pause / resume / archive. Validate mode transition rules (24h paper minimum).

### 6.4 Manual Cycle Trigger Callable [S]
Spec: 03-trade-loop.md → `manualCycleTrigger`

Rate limited: 3 per minute. Calls `runStrategyLoop` directly.

### 6.5 Connect Broker Callable [M]
Spec: 07-security.md → Layer 2 → "Key Validation on Connect"

Validate credentials, store in Secret Manager, update Firestore metadata.
Separate functions for Binance and IBKR.

### 6.6 IBKR Fill Poller [M]
File: `functions/src/brokers/ibkr.js`
Spec: 03-trade-loop.md → `ibkrFillPoller`

Scheduled every 2 minutes. Polls pending IBKR fills, updates trades and positions.
Timeout detection (40+ minutes = timeout error, notify user).

### 6.7 Price Monitor [M]
Spec: 03-trade-loop.md → `priceMonitor`

Scheduled every 5 minutes. Checks price thresholds, writes `priceEvents`.
Respects per-threshold cooldown to prevent spam.

### 6.8 Event-Driven Trade Loop [S]
Spec: 03-trade-loop.md → `tradeLoopOnPriceEvent`

Firestore onWrite trigger for `priceEvents`. Calls `runStrategyLoop` for the
specific strategy. Mark price event as processed.

### 6.9 Daily Stats Computer [L]
Spec: 03-trade-loop.md → `computeDailyStats`

Recomputes all strategy stats, Sharpe/Sortino ratios, resets daily counters,
saves daily systemMetrics snapshot.

### 6.10 Daily Summary Notifier [M]
Scheduled daily. Generates Claude summary per user, sends FCM digest.

### 6.11 Trade Export Generator [M]
HTTPS callable. Generates CSV of trade history in Firestore, uploads to Cloud Storage,
returns signed download URL (valid 1 hour). Include all tax fields.

### 6.12 Health Check Endpoint [S]
Spec: 08-monitoring.md → "Health Check Endpoint"

HTTP endpoint. No auth required. Returns JSON health status.

---

## Phase 7: Live Trading

### 7.1 Live Order Execution [M]
File: `functions/src/tradeLoop/strategyRunner.js`
Spec: 03-trade-loop.md → Phase 8 — live path

Add the live execution path to `executeOrSimulate`. Implement for Binance first.
**Gate:** Only activate after 72 hours of paper trading with zero bugs.

### 7.2 IBKR Live Orders [M]
Extend live execution path for IBKR. Test with small position sizes.

### 7.3 Live Integration Test [XL]
Deploy to production (not emulator).
Fund Binance testnet account.
Create one live strategy on testnet.
Monitor for 24 hours: verify every cycle executes, every trade records correctly,
every error is caught and logged, no duplicate orders.

---

## Phase 8: Flutter App

### 8.1 Firebase Setup (Flutter) [S]
Run `flutterfire configure`.
Add `google-services.json` (Android) and `GoogleService-Info.plist` (iOS equivalent for web).

### 8.2 App Shell, Theme, Router [M]
File: `flutter_app/lib/`
Spec: 05-flutter-ui.md → Theme Configuration, Navigation Structure

Set up go_router with auth redirect, user shell, admin shell.
Implement dark/light theme switching.

### 8.3 Auth Screens [M]
Spec: 05-flutter-ui.md → AuthScreen

Login, register, forgot password. Firebase Auth integration.
Email verification enforcement before strategy creation.

### 8.4 Riverpod Providers [M]
Spec: 05-flutter-ui.md → "State Management — Providers"

All core providers: auth, user, strategies, cycles, trades, analytics, admin.
Test each provider in isolation with mock Firestore.

### 8.5 Shared Widget Library [M]
Spec: 05-flutter-ui.md → "Reusable Widget Library"

Build all shared widgets: StatusDot, HoldToConfirmButton, PnlText, ModeBadge,
MetricCard, CycleEntryCard, ConfidenceBar, BrokerChip, EmptyState, ErrorState,
SkeletonCard, SkeletonList.

### 8.6 Broker Connection Screens [M]
Spec: 05-flutter-ui.md → BrokerConnectionsScreen

Bottom sheets for Binance and IBKR connection.
Call `connectBroker` Cloud Function. Handle errors gracefully.

### 8.7 Onboarding Flow [M]
Spec: 05-flutter-ui.md → OnboardingFlow

4-step flow: welcome, connect broker, create strategy prompt, paper mode explanation.

### 8.8 Strategies Overview Screen [M]
Spec: 05-flutter-ui.md → StrategiesOverviewScreen

Strategy cards with real-time Firestore streams.
Next cycle countdown timer (computed from lastCycleAt + checkIntervalMinutes).

### 8.9 New Strategy Flow [L]
Spec: 05-flutter-ui.md → NewStrategyFlow

6-step flow with Claude chat in step 2.
Call `strategySetup` Cloud Function with conversation history.
Animate Claude responses character by character.
Risk settings sliders. Asset management.

### 8.10 Strategy Detail Screen [L]
Spec: 05-flutter-ui.md → StrategyDetailScreen

3 tabs: Portfolio, Reasoning Feed, Trade Log.
Emergency sell button (HoldToConfirmButton, live only).
Mode switching with hold-to-confirm and 60-second grace period.

### 8.11 Cycle Detail Screen [M]
Spec: 05-flutter-ui.md → CycleDetailScreen

All expandable sections. Claude raw response for power users.

### 8.12 Trade Detail Screen [M]
Tax fields display. Claude reasoning. Link to opening trade (for sells).

### 8.13 Analytics Dashboard [L]
Spec: 05-flutter-ui.md → AnalyticsDashboardScreen

All charts with fl_chart. Server-side data via Cloud Function.
Time range selector, strategy filter, mode filter.

### 8.14 Notification History Screen [S]
List of past FCM notifications stored in Firestore.

### 8.15 Settings Screens [M]
Account, broker connections, notification preferences.
Account deletion flow with 30-day grace period.

### 8.16 FCM Integration [M]
Spec: 05-flutter-ui.md → "FCM Push Notification Handling"

Foreground + background handlers. Deep link navigation from notifications.
Token refresh handling.

---

## Phase 9: Admin Dashboard

### 9.1 Admin Shell and Route Guard [S]
Admin-only routes. Server-side role verification on every admin Cloud Function.

### 9.2 Admin Overview Screen [M]
Spec: 05-flutter-ui.md → AdminOverviewScreen

Real-time metrics from `systemMetrics/current`. Health banner.
All charts from daily snapshots.

### 9.3 Admin Users Screen [M]
Spec: 05-flutter-ui.md → AdminUsersScreen + AdminUserDetailScreen

Searchable data table. User detail with all tabs.
Suspend/reactivate/promote actions via Cloud Functions.

### 9.4 Admin Transactions Screen [M]
Spec: 05-flutter-ui.md → AdminTransactionsScreen

Server-side filtered data table. CSV export.

### 9.5 Admin Error Log Screen [M]
Spec: 05-flutter-ui.md → AdminErrorLogScreen

Real-time error feed. Mark resolved. Bulk actions.

### 9.6 Admin Audit Log Screen [S]
Read-only log of all admin actions from `adminAuditLog`.

---

## Phase 10: Monitoring Setup

### 10.1 GCP Alerting Policies [M]
Spec: 08-monitoring.md → "GCP Cloud Monitoring: Alerting Policies"

Create all 8 alerting policies in GCP Console.
Test each by artificially triggering the condition.

### 10.2 Log-Based Metrics [M]
Spec: 08-monitoring.md → "Custom Metrics via Cloud Logging"

Create custom metrics in GCP Console from structured log fields.

### 10.3 Uptime Monitor [S]
Set up UptimeRobot free account.
Monitor `/healthCheck` endpoint every 5 minutes.
Alert channel: email + SMS.

### 10.4 Log Export for Audit [S]
Spec: 08-monitoring.md → "Log Retention and Query"

Configure log sink to Cloud Storage bucket for 7-year financial audit retention.

---

## Phase 11: Pre-Launch Checklist

Before putting real money in:

### Security
- [ ] All Firestore security rules deployed and tested
- [ ] No API keys in Flutter client (verify with `grep -r "AKIA\|sk-\|api_key" flutter_app/`)
- [ ] All Cloud Function inputs validated with Zod
- [ ] Rate limiting active on all callable functions
- [ ] Admin role verified server-side in all admin functions
- [ ] Prompt injection sanitiser active

### Reliability
- [ ] Idempotency keys working — manually retry a trade loop and confirm no duplicate order
- [ ] Emergency sell tested in paper mode — confirms all positions sold
- [ ] Auto-pause tested — manually breach drawdown limit, confirm strategy pauses
- [ ] Claude timeout tested — confirm cycle skips gracefully on 30s timeout
- [ ] Broker down tested — confirm other strategies continue when one broker fails

### Monitoring
- [ ] All GCP alerts configured and tested
- [ ] Health check endpoint returning 200
- [ ] UptimeRobot monitoring active
- [ ] Admin FCM notifications received for test critical error
- [ ] Log export to Cloud Storage working

### Data
- [ ] All Firestore indexes built (check GCP Console → Firestore → Indexes)
- [ ] TTL policies active (check GCP Console → Firestore → TTL)
- [ ] Daily stats function tested manually

### Financial
- [ ] Paper mode runs for minimum 72 hours without errors
- [ ] Position FIFO math verified against manual calculation
- [ ] Tax fields populated correctly on sell trades
- [ ] Trade export CSV generated and verified

### Start with minimum viable live test
- Fund $20 on Binance live account
- One strategy, Binance only, one asset (BTC), 15-min interval
- Max trade size: $5 (25% of $20)
- Max drawdown: 25% ($5)
- Monitor every cycle for first 48 hours
- Only expand after confirming the loop runs cleanly
