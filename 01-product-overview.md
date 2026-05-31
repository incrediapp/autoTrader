# AI Trader — Product Overview
## Version: Production-Ready Spec v2

---

## What This Is

A production-grade AI trading system where users describe trading strategies in plain
English, and Claude executes them autonomously against real brokerage accounts (Binance
for crypto, Interactive Brokers for stocks). The system runs continuously, logs every
decision with full Claude reasoning, enforces hard risk limits, and surfaces everything
through a Flutter dashboard on Android and Web.

A parallel admin dashboard provides full system observability: per-user stats,
transaction-level metrics, error monitoring, and cost tracking.

This is built to production standards from day one: idempotent execution, audit trails,
security hardening, monitoring, graceful degradation, and a data model that supports
both current personal use and future multi-user scale.

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Flutter (Android + Web) | Single codebase, no iOS initially |
| Backend runtime | Firebase Cloud Functions v2 (Node.js 20) | Scales to zero, integrates with Firestore natively |
| Database | Cloud Firestore | Real-time listeners, offline support, flexible schema |
| Auth | Firebase Auth | Email + Google, extensible |
| Push notifications | Firebase Cloud Messaging (FCM) | Cross-platform, integrates with Flutter |
| Secret storage | Google Cloud Secret Manager | API keys never touch Firestore or client |
| AI reasoning | Anthropic Claude API (claude-haiku-4-5) | Fast, cheap, sufficient for structured decisions |
| Scheduling | Firebase Cloud Scheduler | Managed cron, no server to maintain |
| Crypto broker | Binance REST API | Global availability, fractional trading, 24/7 |
| Stock broker | Interactive Brokers Web API | Available in Israel, multi-asset, institutional grade |
| Market data | Binance API (crypto), IBKR API (stocks) | Free with brokerage account |
| Technical indicators | Computed in Cloud Function (technicalindicators npm) | No external dependency cost |
| Sentiment | Alternative.me Fear & Greed Index | Free, cached, crypto-specific |
| News | Newsdata.io | Affordable, global, cacheable |
| Monitoring | Google Cloud Monitoring + Firestore errorLogs | Unified alerting |

---

## Core Concepts

### Strategy
A user-defined trading plan described in plain English via a guided Claude chat.
Claude interprets it, asks clarifying questions, confirms understanding, and stores
it as structured config. Multiple strategies run simultaneously, each independent,
each with its own assets, broker, risk params, and decision mode.

### Decision Mode (switchable per strategy at any time)
**Rule Interpreter mode:**
Claude converts the strategy description into an explicit rule set stored in Firestore.
The trade loop evaluates rules deterministically on every cycle. Claude is only called
when a rule triggers (to generate a human-readable summary) or when rules need updating.
Characteristics: predictable, auditable, cheap, debuggable. Recommended starting mode.

**Autonomous Reasoner mode:**
Every cycle, Claude receives the full market context, portfolio state, and strategy
description and decides freely: buy, sell, hold, suggest an asset, or flag the strategy
for review. Characteristics: flexible, handles nuanced conditions, costs more per cycle,
harder to debug when wrong.

Both modes share the same risk validation layer — Claude's output is always checked
against hard risk limits before execution regardless of mode.

### Trade Loop
The core execution unit. Runs as a Cloud Function on a 15-minute schedule and also
on event-driven triggers (price thresholds). For each active strategy:
fetch market data → compute indicators → get Claude decision → validate against
risk limits → execute or simulate → log everything → notify user.

The loop is designed to fail safely: any error skips that strategy's cycle and logs
it, but does not affect other strategies. No silent failures.

### Paper vs Live Mode
Every strategy has a `mode` flag: `paper` or `live`. Paper mode runs the full loop
including real Claude reasoning against real-time prices, but orders are simulated
(Binance testnet for crypto, simulated fills for IBKR). The user manually switches
to live per strategy after validating paper performance. There is no automatic
paper → live promotion.

### Idempotency
Every live order placement is guarded by an idempotency key stored in Firestore
before the broker call. If a Cloud Function retries (Firebase may retry on failure),
the duplicate is detected and the order is not placed twice. This is non-negotiable
for a money-handling system.

---

## Known Risks and Mitigations

### Risk: Claude returns malformed JSON
**Mitigation:** All Claude responses are parsed with try/catch and validated against
a schema before any action is taken. On parse failure, the cycle is logged as an error
and skipped. The raw response is stored for debugging. This has happened in testing —
treat it as a certainty, not an edge case.

### Risk: Duplicate orders on Cloud Function retry
**Mitigation:** Idempotency keys written to Firestore atomically before broker call.
Key includes: strategyId + cycleId + side + symbol. On retry, key already exists →
skip order. Key TTL: 24 hours (cleaned by scheduled function).

### Risk: Broker API is down during cycle
**Mitigation:** Retry with exponential backoff (3 attempts, 2s/4s/8s). After 3
failures, log a critical error, skip the cycle, notify the user, and set a
`brokerUnreachable` flag on the strategy. Next cycle re-attempts broker connection
before proceeding.

### Risk: Claude API is down or slow
**Mitigation:** 30-second timeout on all Claude calls. On timeout or 5xx, skip
cycle and log. In rule interpreter mode, fall back to deterministic rule evaluation
without Claude (no reasoning summary generated). In autonomous mode, skip cycle
entirely — never guess.

### Risk: Price data is stale
**Mitigation:** Every market snapshot includes a `dataFreshnessMs` field: the age
of the most recent candle vs current time. If data is more than 20 minutes old,
the cycle logs a warning and skips execution. Stale data is worse than no data.

### Risk: Strategy bleeds money before drawdown limit hits
**Mitigation:** Drawdown is checked at the start of every cycle against peak
portfolio value. Peak is updated any time portfolio value increases. Auto-pause
is immediate when threshold is crossed, before any Claude call or order.

### Risk: User switches to live mode accidentally
**Mitigation:** Live mode switch requires a hold-to-confirm gesture (2 seconds),
an explicit confirmation dialog with current paper P&L shown, and a 60-second
cooldown before the first live trade executes (allowing user to panic-cancel).

### Risk: Emergency sell fails for one position
**Mitigation:** Emergency sell is fire-and-forget per position (Promise.allSettled).
Each position sell is attempted independently. Failures are logged per-position and
surfaced to the user showing exactly which positions sold and which failed.
The user must manually handle failed sells via the broker directly.

### Risk: FCM token goes stale (user reinstalls app)
**Mitigation:** Flutter app refreshes FCM token on every launch and on
`onTokenRefresh` callback. Token is written back to Firestore atomically.
Notification sends that fail with `messaging/registration-token-not-registered`
trigger token cleanup in Firestore.

### Risk: Firestore write costs blow up at scale
**Mitigation:** Cycles are written once (not updated). Trades are written once.
Counter increments use Firestore distributed counters for high-write fields
(totalCycles, totalTrades). Metrics aggregation runs in a daily batch, not on
every trade. Price event documents are deleted after processing.

### Risk: Newsdata.io free tier (200 req/day) exhausted
**Mitigation:** News is cached per symbol group for 30 minutes in Firestore.
With 5 strategies checking every 15 minutes, worst case is 480 potential news
calls per day — but deduplication by symbol set reduces this drastically.
If quota is exhausted, the cycle continues without news data (it's informational,
not required). Log quota exhaustion as a warning.

### Risk: IBKR token expires mid-cycle
**Mitigation:** Token is refreshed proactively if it expires within 5 minutes.
Refresh happens at the start of any Cloud Function that uses IBKR, before any
market data or order calls. If refresh fails (refresh token also expired), the
strategy is auto-paused with reason `ibkr_auth_expired` and the user is notified
to re-authenticate.

### Risk: Strategy runs outside market hours (stocks)
**Mitigation:** IBKR strategies have `activeHours` config. The trade loop checks
market hours before executing stock orders. Crypto (Binance) runs 24/7 by design.
If a stock cycle triggers outside market hours, indicators are still computed and
logged (for analysis) but no order is placed. Instead, a "market closed, will
execute at open" flag is set if the decision was to trade.

### Risk: User has insufficient balance for a buy
**Mitigation:** Validation layer checks available cash before passing to broker.
If insufficient, order is clamped to 95% of available cash. If that's below $1,
the cycle skips with reason `insufficient_cash` and notifies the user.

### Risk: Split-brain between Firestore portfolio snapshot and broker reality
**Mitigation:** The portfolio snapshot is always fetched fresh from the broker
at the start of each cycle. Firestore stores the snapshot for UI and logging only.
The broker is always the source of truth for portfolio state. There is no caching
of portfolio between cycles.

---

## User-Facing Features (Complete)

### Onboarding
1. Register with email or Google
2. Connect at least one broker (Binance and/or IBKR)
3. Create first strategy via Claude chat
4. Review paper mode for minimum 24 hours before going live (enforced — UI blocks
   live switch until 24 hours of paper history exists)

### Strategy Management
- Create via Claude chat (guided, multi-turn)
- View Claude's interpretation summary before confirming
- Edit: update description → Claude re-interprets → user confirms new rules/summary
- Clone an existing strategy (copy config, reset stats)
- Pause / resume (immediate, next cycle is skipped)
- Auto-pause (by drawdown limit or broker auth failure — with reason shown)
- Archive (soft delete, history preserved)
- Delete (hard delete, requires typing strategy name to confirm)
- Switch decision mode (rule interpreter ↔ autonomous) — takes effect next cycle
- Switch paper ↔ live (24h paper minimum enforced, hold-to-confirm, 60s grace period)

### Live Dashboard (per strategy)
- Current positions with unrealised P&L (live from Firestore, updated each cycle)
- Portfolio value chart (sparkline, 7-day)
- Status indicator: active / paused / auto-paused / live / paper
- Last action: what happened last cycle with Claude's one-line reasoning
- Next check: countdown timer to next scheduled cycle
- What Claude is watching (pending signals in rule mode)
- Broker connectivity status (green / red)

### Reasoning Feed
- Every cycle logged, reverse-chronological, paginated 50 at a time
- Each entry: action, timestamp, one-line reasoning, key market data snapshot
- Colour coded: BUY (green), SELL (red), HOLD (blue), ERROR (orange), SUGGEST (purple)
- Tap any entry: full detail sheet with complete Claude response, full market snapshot,
  full portfolio snapshot, which rules triggered (rule mode), confidence score (auto mode)
- Filter: All / Trades only / Holds / Errors / Suggestions
- Search by date range

### Trade Log
- All executed and simulated trades, reverse-chronological
- Per trade: asset, side, quantity, price, notional, fees, P&L (if closed), mode
- Match buy/sell pairs: show holding period and realised P&L per round trip
- Tap: full detail including Claude reasoning, tax fields
- Filter: all / live only / paper only / by asset / by date range
- Export: generate CSV download (via Cloud Function) with all tax fields

### Analytics Dashboard
- Time range selector: 7D / 30D / 90D / All time
- Strategy filter: all strategies / individual
- Mode filter: paper / live / both

**Performance metrics:**
- Total P&L (USD and %)
- Win rate (% of closed trades profitable)
- Average win / average loss (ratio)
- Profit factor (gross profit / gross loss)
- Sharpe ratio (annualised, computed weekly)
- Sortino ratio
- Max drawdown (% from peak)
- Max drawdown duration
- Recovery factor

**Charts:**
- Equity curve (line chart, portfolio value over time)
- Drawdown chart (filled area, shows drawdown % over time)
- P&L by asset (horizontal bar)
- P&L by time of day (heatmap — useful for spotting timing patterns)
- Trade frequency per day (bar chart)
- Win/loss distribution (histogram of trade P&L)
- Claude API cost per day (line chart)

**Strategy comparison table (when multiple strategies active):**
- Strategy | Trades | Win% | P&L | Sharpe | Max DD | Claude cost | Mode

### Notifications
Configurable globally and per-strategy. All notification events:
- `trade_executed`: every live or paper trade
- `cycle_complete`: every 15-min cycle (verbose mode — off by default)
- `stop_loss_triggered`: per-trade stop loss hit
- `drawdown_limit_hit`: portfolio drawdown auto-pause triggered
- `bot_paused`: any auto-pause (with reason)
- `asset_suggested`: Claude suggested a new asset
- `broker_error`: broker API call failed
- `broker_reconnected`: broker connection restored after failure
- `ibkr_auth_expiring`: IBKR token expires in < 2 hours
- `strategy_flagged_for_review`: Claude flagged strategy as needing update
- `daily_summary`: P&L, trades taken, bot status for the day
- `weekly_summary`: performance metrics for the week

### Controls
- Emergency "Sell Everything" (hold 2s, sells all live positions across all strategies)
- Per-strategy: Pause / Resume
- Per-strategy: Emergency sell (strategy-scoped)
- Paper ↔ Live toggle (hold 2s + confirmation dialog)
- Decision mode toggle
- Manual cycle trigger (force a cycle to run now, for testing)

---

## Admin Features (Complete)

### System Overview Dashboard
Real-time from `systemMetrics/current`:
- Total registered users / active in last 24h / active in last 7d
- Active strategies (live vs paper split)
- Cycles today / this week / total
- Trades today (live + paper separately) / total
- Total notional volume today / this week / all time
- Claude API calls today + cost today + cost this month
- Error rate: errors / total cycles (last 24h)
- Broker error counts: Binance and IBKR separately
- FCM delivery success rate

Charts (from daily snapshots):
- New users per day (30-day)
- Daily trade volume (30-day)
- Daily Claude cost (30-day)
- Error rate trend (30-day)
- Live vs paper strategy count over time

### Users Table
Searchable + sortable table of all users:
- Name | Email | Joined | Last active | Strategies | Live trades | P&L | Claude cost | Status

Filters: active / suspended / deleted / admin

Actions per row: View detail, Suspend, Promote to admin

### User Detail Screen
- Full profile + stats
- All strategies (with link to each)
- Recent trades (last 20, with link to full log)
- Claude API usage breakdown per strategy
- Error log for this user (last 20)
- Admin action history for this user

### Transactions Screen
Full trade log across ALL users. Searchable and filterable:
- Filters: user, strategy, broker, asset, side, mode, date range, P&L sign
- Columns: user | strategy | broker | asset | side | mode | qty | price | notional | fee | P&L | timestamp
- Expandable row: shows Claude reasoning for that trade
- Export as CSV (server-side, returns download URL)

### Error Log Screen
Real-time feed of all system errors:
- Filters: source, severity, resolved/unresolved, user, date range
- Severity colour coding: warning (amber) / error (red) / critical (dark red)
- Expandable: full stack trace, metadata, cycle context
- Mark resolved (with optional resolution note)
- Bulk resolve
- Alert thresholds: if error rate > 5% in 15 min, alert admin via email

### Audit Log
Every admin action recorded:
- Admin | Action | Target | Before | After | Timestamp
- Read-only, no deletion

---

## Data Retention Policy

| Data type | Retention | Cleanup method |
|---|---|---|
| Trade records (live) | 7 years (regulatory) | Manual — never auto-deleted |
| Trade records (paper) | 1 year | Firestore TTL |
| Cycle logs | 90 days | Firestore TTL |
| Raw Claude responses | 90 days | Firestore TTL |
| Market snapshots | 30 days | Firestore TTL |
| Price events | 24 hours after processed | Firestore TTL |
| Error logs | 1 year | Firestore TTL |
| System metrics (daily) | Indefinite | Never deleted |
| Idempotency keys | 24 hours | Firestore TTL |
| News cache | 30 minutes | Firestore TTL |
| Fear & Greed cache | 1 hour | Firestore TTL |

---

## Tax Reporting

The app does not generate official tax documents. It stores all tax-relevant
fields per trade: asset, side, timestamp, quantity, entry price, exit price,
fees, realised P&L, cost basis, proceeds, holding period.

A CSV export (accessible in the Trade Log screen and the Admin Transactions screen)
includes all these fields in a format compatible with most accounting software.

Official transaction records should be obtained directly from Binance and IBKR,
which produce regulator-compliant reports. The app's CSV is a supplementary tool,
not a replacement.

Tax note specific to Israel: capital gains on crypto and stocks held by Israeli
residents are subject to 25% capital gains tax. Short-term (< 1 year) and
long-term holdings may be treated differently. Consult a licensed Israeli tax
advisor. The app's CSV export includes acquisition date and holding period per
trade to facilitate this calculation.

---

## Non-Functional Requirements

### Performance
- Trade loop cycle must complete within 30 seconds for up to 20 active strategies
- Claude API call timeout: 30 seconds (fail-safe, not hang)
- Firestore reads per cycle: < 10 document reads per strategy
- Flutter app cold start: < 3 seconds on mid-range Android
- Admin dashboard initial load: < 5 seconds
- All Firestore queries must use indexes — no full-collection scans

### Reliability
- Trade loop must handle broker outage without crashing other strategies
- Cloud Functions must be idempotent on retry
- No trade must ever be placed twice
- Auto-pause must activate within one cycle of drawdown limit breach
- System must degrade gracefully: if news API is down, cycle continues without news

### Security
- Zero API keys in Flutter client or Firestore
- All financial operations server-side only
- Firestore security rules deny all client writes to system collections
- Admin role verified server-side in every Cloud Function (not just in UI)
- All Cloud Function inputs validated and sanitised
- Rate limiting on all HTTPS callable functions
- See 07-security.md for full security spec

### Observability
- Every Cloud Function execution logged with duration, strategy count, error count
- Every broker API call timed and logged
- Every Claude API call logged with token counts and cost
- Admin dashboard reflects real state within 60 seconds
- See 08-monitoring.md for full observability spec

### Cost Management
- Claude costs estimated and displayed per strategy, per day, in the UI
- Admin sees total Claude cost per day vs a configurable budget alert threshold
- News API quota tracked and alerted at 80% usage
- Firestore read/write costs tracked via GCP billing alerts

---

## Implementation Order

See 09-implementation-order.md for the full phased build plan with exact task ordering.
