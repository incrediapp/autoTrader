# Monitoring & Observability Spec
## Version: Production-Ready Spec v1

---

## Philosophy

A trading bot that fails silently is worse than one that doesn't run at all.
Every failure must be visible, attributable, and actionable within minutes.

The monitoring stack is layered:
1. **Structured logging** — every Cloud Function logs structured JSON to Cloud Logging
2. **Firestore error collection** — application-level errors persisted for admin UI
3. **GCP Cloud Monitoring** — infrastructure metrics, uptime checks, alerting
4. **In-app admin dashboard** — real-time system health visible without GCP Console
5. **FCM alerts** — critical failures push to admin's phone immediately

---

## Structured Logging in Cloud Functions

Every Cloud Function uses a consistent structured log format.
Google Cloud Logging indexes these fields for querying.

```javascript
const { logger } = require('firebase-functions');

// Standard log context — attach to every log entry in a function invocation
function createLogContext(functionName, userId = null, strategyId = null) {
  return {
    service:    'ai-trader',
    function:   functionName,
    userId:     userId ?? 'system',
    strategyId: strategyId ?? 'none',
    env:        process.env.FUNCTIONS_EMULATOR ? 'local' : 'production',
  };
}

// Structured log helper
function logInfo(ctx, message, extra = {}) {
  logger.info(message, { ...ctx, ...extra });
}

function logWarn(ctx, message, extra = {}) {
  logger.warn(message, { severity: 'WARNING', ...ctx, ...extra });
}

function logError(ctx, message, err, extra = {}) {
  logger.error(message, {
    severity: 'ERROR',
    ...ctx,
    errorMessage: err?.message,
    errorCode:    err?.code ?? null,
    stack:        err?.stack?.split('\n').slice(0, 5).join(' | ') ?? null,
    ...extra,
  });
}

// Every trade loop run logs a structured summary
function logCycleSummary(ctx, {
  runId, totalStrategies, eligibleStrategies,
  tradeCount, errorCount, durationMs
}) {
  logger.info('Trade loop run complete', {
    ...ctx,
    event:             'TRADE_LOOP_COMPLETE',
    runId,
    totalStrategies,
    eligibleStrategies,
    tradeCount,
    errorCount,
    errorRatePct:      eligibleStrategies > 0
                         ? ((errorCount / eligibleStrategies) * 100).toFixed(1)
                         : 0,
    durationMs,
    avgStrategyMs:     eligibleStrategies > 0
                         ? Math.round(durationMs / eligibleStrategies)
                         : 0,
  });
}

// Every broker API call is timed and logged
function logBrokerCall(ctx, {
  broker, endpoint, method, success, durationMs, errorCode = null
}) {
  logger.info('Broker API call', {
    ...ctx,
    event:      'BROKER_API_CALL',
    broker,
    endpoint,
    method,
    success,
    durationMs,
    errorCode,
  });
}

// Every Claude API call is logged with cost
function logClaudeCall(ctx, {
  promptVersion, promptTokens, completionTokens,
  costUsd, latencyMs, parseSuccess, mode
}) {
  logger.info('Claude API call', {
    ...ctx,
    event:            'CLAUDE_API_CALL',
    promptVersion,
    promptTokens,
    completionTokens,
    totalTokens:      promptTokens + completionTokens,
    costUsd:          costUsd.toFixed(6),
    latencyMs,
    parseSuccess,
    mode,
  });
}
```

---

## GCP Cloud Monitoring: Alerting Policies

Configure these alert policies in Google Cloud Monitoring.
All alerts send to: admin email + admin FCM push notification.

### Alert 1: Trade Loop Execution Failure

```
Metric:    logging/user/trade_loop_error_count
           (custom metric, written via logMetric below)
Condition: Count > 3 in 15 minutes
Severity:  Critical
Message:   "Trade loop failing: {count} strategy errors in last 15 minutes"
```

### Alert 2: Trade Loop Not Running

```
Metric:    logging/user/trade_loop_start_count
Condition: Count == 0 for 20 consecutive minutes (loop should run every 15)
Severity:  Critical
Message:   "Trade loop has not started in 20 minutes — Cloud Scheduler may have stalled"
```

### Alert 3: Cloud Function Cold Start Rate

```
Metric:    cloudfunctions.googleapis.com/function/active_instances
Condition: Active instances for tradeLoopScheduled == 0 for > 5 minutes
           (indicates function is not being invoked)
Severity:  Critical
```

### Alert 4: High Claude API Latency

```
Metric:    logging/user/claude_latency_ms
Condition: p95 > 25000ms over 30 minutes
Severity:  Warning
Message:   "Claude API responding slowly — p95 latency {value}ms"
```

### Alert 5: Claude API Cost Spike

```
Metric:    logging/user/claude_cost_usd_daily
Condition: Sum > {configured_budget} USD in current calendar day
Severity:  Warning
Message:   "Claude API daily cost exceeded budget: ${value}"
```

### Alert 6: Broker API Error Rate

```
Metric:    logging/user/broker_error_count
Condition: Count > 5 in 15 minutes (for any single broker)
Severity:  Warning
Message:   "Broker API errors elevated: {broker} — {count} errors in 15 minutes"
```

### Alert 7: Firestore Write Failures

```
Metric:    firestore.googleapis.com/document/write_count
           (filtered to error responses)
Condition: Error writes > 10 in 5 minutes
Severity:  Warning
```

### Alert 8: GCP Budget Alert

```
Service:   GCP Billing Budget Alert
Threshold: 50% / 75% / 90% / 100% of monthly budget
Action:    Email to admin
```

---

## Custom Metrics via Cloud Logging

Cloud Monitoring can extract custom metrics from structured log entries.
Configure these log-based metrics in GCP Console:

```javascript
// Write a custom metric from within a Cloud Function
const { MetricServiceClient } = require('@google-cloud/monitoring');
const monitoringClient = new MetricServiceClient();

async function writeMetric(metricType, value, labels = {}) {
  const now = Date.now();
  await monitoringClient.createTimeSeries({
    name: `projects/${process.env.GCLOUD_PROJECT}`,
    timeSeries: [{
      metric: {
        type: `custom.googleapis.com/ai_trader/${metricType}`,
        labels
      },
      resource: {
        type: 'global',
        labels: { project_id: process.env.GCLOUD_PROJECT }
      },
      points: [{
        interval: { endTime: { seconds: Math.floor(now / 1000) } },
        value: { doubleValue: value }
      }]
    }]
  });
}

// Called at end of each trade loop run
await writeMetric('trade_loop_duration_ms',    durationMs,   { trigger: triggeredBy });
await writeMetric('trade_loop_error_count',    errorCount,   {});
await writeMetric('trade_loop_trade_count',    tradeCount,   { mode: 'live' });
await writeMetric('claude_cost_usd',           totalCostUsd, {});
await writeMetric('claude_latency_ms',         avgLatencyMs, {});
await writeMetric('broker_api_error_count',    brokerErrors, { broker: 'binance' });
```

---

## Application-Level Error Logging (Firestore)

Every error that warrants admin attention is written to the `errorLogs` collection.
This powers the in-app admin error feed without requiring GCP Console access.

```javascript
async function logError({
  source, severity, userId = null, strategyId = null,
  cycleId = null, tradeId = null,
  message, stack = null, errorCode = null,
  retryable = false, metadata = {},
  alertAdmin = false
}) {
  const errorId = `${Date.now()}_${nanoid(8)}`;

  // Always log to Cloud Logging first (fast, async)
  logger.error(message, {
    event:      'APP_ERROR',
    errorId,
    source,
    severity,
    userId,
    strategyId,
    errorCode,
    retryable,
  });

  // Write to Firestore (slower — use set not runTransaction for speed)
  const errorDoc = {
    errorId, source, severity,
    userId, strategyId, cycleId, tradeId,
    message: message.slice(0, 1000),  // cap message length
    errorCode,
    stack: stack?.split('\n').slice(0, 8).join('\n').slice(0, 2000) ?? null,
    retryable,
    metadata: maskSecrets(sanitiseMetadata(metadata)),
    occurredAt: FieldValue.serverTimestamp(),
    resolved: false,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    alertSent: false,
    alertSentAt: null,
    expireAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  };

  await db.collection('errorLogs').doc(errorId).set(errorDoc);

  // Alert admin for critical errors
  if (severity === 'critical' || alertAdmin) {
    await alertAdminOfCriticalError(errorDoc);
  }

  // Update system metrics error counter
  await db.doc('systemMetrics/current').update({
    errorCyclesToday: FieldValue.increment(1),
  });

  return errorId;
}

async function alertAdminOfCriticalError(error) {
  // Get all admin users' FCM tokens
  const admins = await db.collection('users')
    .where('role', '==', 'admin')
    .get();

  const tokens = admins.docs
    .flatMap(d => d.data().notifications?.fcmTokens ?? [])
    .filter(Boolean);

  if (tokens.length === 0) return;

  // Send FCM to all admin tokens
  await sendFCMToTokens(tokens, {
    title: `⚠️ Critical Error: ${error.source}`,
    body: error.message.slice(0, 100),
    data: {
      type: 'admin_critical_error',
      errorId: error.errorId,
      link: `/admin/errors?id=${error.errorId}`
    }
  });

  await db.collection('errorLogs').doc(error.errorId).update({
    alertSent: true,
    alertSentAt: FieldValue.serverTimestamp()
  });
}
```

---

## Performance Monitoring

### Cloud Function Execution Timing

Every Cloud Function logs a timing breakdown:

```javascript
class PerformanceTimer {
  constructor(functionName) {
    this.functionName = functionName;
    this.start = Date.now();
    this.phases = {};
    this.currentPhase = null;
    this.currentPhaseStart = null;
  }

  startPhase(name) {
    if (this.currentPhase) this.endPhase();
    this.currentPhase = name;
    this.currentPhaseStart = Date.now();
  }

  endPhase() {
    if (!this.currentPhase) return;
    this.phases[this.currentPhase] = Date.now() - this.currentPhaseStart;
    this.currentPhase = null;
  }

  finish() {
    if (this.currentPhase) this.endPhase();
    const totalMs = Date.now() - this.start;

    logger.info('Function performance', {
      event:      'FUNCTION_PERFORMANCE',
      function:   this.functionName,
      totalMs,
      phases:     this.phases,
      slowPhases: Object.entries(this.phases)
                    .filter(([, ms]) => ms > 2000)
                    .map(([name, ms]) => `${name}:${ms}ms`)
    });

    return { totalMs, phases: this.phases };
  }
}

// Usage in trade loop:
const timer = new PerformanceTimer('tradeLoopScheduled');

timer.startPhase('portfolio_fetch');
portfolioSnapshot = await fetchPortfolio(strategy, userId);

timer.startPhase('market_data');
marketSnapshot = await fetchMarketData(strategy, userId);

timer.startPhase('claude');
claudeResult = await getClaudeDecision(strategy, portfolioSnapshot, marketSnapshot);

timer.startPhase('execution');
tradeResult = await executeOrSimulate(...);

const perf = timer.finish();
// perf.phases stored in cycle document for per-cycle debugging
```

### Performance Budgets

If any phase exceeds these thresholds, log a warning:

| Phase | Warning threshold | Critical threshold |
|---|---|---|
| Portfolio fetch (Binance) | 3s | 8s |
| Portfolio fetch (IBKR) | 5s | 12s |
| Market data fetch | 5s | 10s |
| Indicator computation | 500ms | 2s |
| External data (news/F&G) | 3s | 8s |
| Claude API call | 8s | 25s |
| Order placement | 5s | 15s |
| Firestore writes | 2s | 5s |
| Total cycle | 30s | 60s |

---

## systemMetrics Real-Time Counters

These counters in `systemMetrics/current` are incremented by Cloud Functions
throughout the day and reset at midnight UTC by `computeDailyStats`.

```javascript
// Helper to atomically increment system metrics
async function incrementSystemMetric(field, amount = 1) {
  await db.doc('systemMetrics/current').update({
    [field]: FieldValue.increment(amount),
    updatedAt: FieldValue.serverTimestamp()
  });
}

// Called throughout Cloud Functions:
// After each cycle starts:
await incrementSystemMetric('cyclesToday', 1);

// After each trade executes (live):
await incrementSystemMetric('liveTradesToday', 1);
await incrementSystemMetric('notionalVolumeUsdToday', trade.executedNotionalUsd);

// After each Claude call:
await incrementSystemMetric('claudeCallsToday', 1);
await incrementSystemMetric('claudeCostUsdToday', costUsd);

// After each error:
await incrementSystemMetric('errorCyclesToday', 1);

// After each broker error:
await incrementSystemMetric(
  broker === 'binance' ? 'binanceApiErrorsToday' : 'ibkrApiErrorsToday', 1);

// After each FCM send:
await incrementSystemMetric('fcmSentToday', 1);
```

---

## Health Check Endpoint

An HTTP function that returns system health — used by external uptime monitors
(e.g. UptimeRobot, Better Uptime) to verify the system is alive.

```javascript
exports.healthCheck = onRequest({
  timeoutSeconds: 10,
  maxInstances: 1,
}, async (req, res) => {
  const checks = {};

  // Check Firestore connectivity
  try {
    const start = Date.now();
    await db.doc('systemMetrics/current').get();
    checks.firestore = { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    checks.firestore = { ok: false, error: err.message };
  }

  // Check Secret Manager connectivity
  try {
    const start = Date.now();
    await getSecret('anthropic_api_key');
    checks.secretManager = { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    checks.secretManager = { ok: false, error: 'unavailable' };
  }

  // Check last trade loop execution time (should be < 20 min ago)
  try {
    const metrics = await db.doc('systemMetrics/current').get();
    const lastCycle = metrics.data()?.lastCycleAt?.toDate();
    const ageMs = lastCycle ? Date.now() - lastCycle.getTime() : null;
    checks.tradeLoop = {
      ok: ageMs !== null && ageMs < 20 * 60 * 1000,
      lastCycleAgeMs: ageMs,
      lastCycleAt: lastCycle?.toISOString() ?? null,
    };
  } catch (err) {
    checks.tradeLoop = { ok: false, error: err.message };
  }

  const allOk = Object.values(checks).every(c => c.ok);

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});
```

Configure UptimeRobot (free) to ping this endpoint every 5 minutes.
Alert channel: admin email + SMS.

---

## Admin Dashboard Metrics (Flutter)

The admin dashboard reads from `systemMetrics/current` via a real-time Firestore
stream. No Cloud Function call needed — the document is always fresh.

### System Health Banner Logic

```dart
String getSystemHealth(SystemMetrics metrics) {
  if (metrics.errorRatePctToday > 10) return 'critical';
  if (metrics.errorRatePctToday > 5)  return 'degraded';
  if (metrics.binanceApiErrorsToday > 20) return 'degraded';
  if (metrics.ibkrApiErrorsToday > 20)    return 'degraded';
  if (metrics.claudeErrorsToday > 10)     return 'degraded';
  return 'healthy';
}
```

### KPI Tiles Updated in Real-Time

```dart
StreamBuilder<SystemMetrics>(
  stream: ref.watch(systemMetricsProvider.stream),
  builder: (context, snapshot) {
    if (!snapshot.hasData) return const SkeletonMetricGrid();
    final m = snapshot.data!;

    return MetricGrid(tiles: [
      MetricTile(label: 'Active users / 24h', value: m.activeUsersLast24h),
      MetricTile(label: 'Active strategies', value: m.activeStrategies,
        subtitle: '${m.liveStrategies} live / ${m.paperStrategies} paper'),
      MetricTile(label: 'Trades today', value: m.tradesToday,
        subtitle: '${m.liveTradesToday} live'),
      MetricTile(label: 'Claude cost today',
        value: '\$${m.claudeCostUsdToday.toStringAsFixed(3)}'),
      MetricTile(label: 'Error rate',
        value: '${m.errorRatePctToday.toStringAsFixed(1)}%',
        valueColor: m.errorRatePctToday > 5 ? AppColors.critical : null),
      MetricTile(label: 'Cycles today', value: m.cyclesToday),
    ]);
  },
)
```

---

## Log Retention and Query

### Cloud Logging Retention
Set to 30 days for standard logs. For audit and financial event logs,
export to Cloud Storage bucket with 7-year retention:

```
Log sink: "financial-audit-logs"
Filter:   jsonPayload.event =~ "TRADE_LOOP|BROKER_API_CALL|EMERGENCY"
          OR jsonPayload.severity = "ERROR"
Destination: gs://ai-trader-audit-logs/
```

### Useful Cloud Logging Queries

```
# All errors in last hour
resource.type = "cloud_function"
jsonPayload.service = "ai-trader"
severity >= ERROR
timestamp >= "1h"

# All trades for a specific user
jsonPayload.event = "BROKER_API_CALL"
jsonPayload.userId = "USER_ID_HERE"

# Slow Claude calls (> 20s)
jsonPayload.event = "CLAUDE_API_CALL"
jsonPayload.latencyMs > 20000

# Trade loop runs with errors
jsonPayload.event = "TRADE_LOOP_COMPLETE"
jsonPayload.errorCount > 0

# Binance rate limit hits
jsonPayload.broker = "binance"
jsonPayload.errorCode = "-1003"
```

---

## Runbook: Common Incidents

### Incident: Trade loop not running
1. Check Cloud Scheduler → is the job enabled and showing recent runs?
2. Check Cloud Functions → is `tradeLoopScheduled` deployed?
3. Check Cloud Logging → any deployment errors in last 30 min?
4. Manual trigger: GCP Console → Cloud Scheduler → "Force run"
5. If persists: redeploy functions (`firebase deploy --only functions:tradeLoopScheduled`)

### Incident: High error rate (> 10%)
1. Check admin error log → which errors are most frequent?
2. If broker errors: check Binance/IBKR status pages
3. If Claude errors: check https://status.anthropic.com
4. If Firestore errors: check GCP status page
5. Auto-pause all live strategies: run `emergencyPauseAll` admin function
6. Notify users via admin FCM broadcast

### Incident: Claude cost spike
1. Check `systemMetrics/current.claudeCallsToday` — how many calls?
2. Check active strategies — did someone create many autonomous strategies?
3. Check individual cycle logs for abnormally high token counts
4. If runaway: pause all autonomous strategies via admin panel
5. Investigate which strategy is consuming disproportionate tokens

### Incident: IBKR token expired for all users
1. All IBKR strategies auto-paused (this is expected behaviour)
2. FCM sent to affected users asking them to re-authenticate
3. Check if IBKR changed their OAuth flow (look for 400 errors in token refresh logs)
4. If IBKR API changed: update Cloud Function and redeploy

### Incident: A live trade was placed twice
1. Immediately verify the duplicate in the broker account
2. Check `idempotencyKeys` collection — was the key written before the first order?
3. Manually close the duplicate position via broker if needed
4. Log as critical incident in errorLogs
5. Review idempotency key logic — was the Cloud Function retried before the key was written?
