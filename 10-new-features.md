# New Features Spec
## Version: 1.0

---

## Overview

This file specifies 9 new features added to the AI Trader system.
Each feature is fully self-contained: Firestore schema additions,
Cloud Function logic, Claude prompt changes, Flutter UI, and implementation notes.

Cross-references to existing spec files are noted where relevant.

---

## Feature Index

| # | Feature | Complexity | New CF | New Collections | New Screens |
|---|---|---|---|---|---|
| 1 | Strategy Performance Autopilot | XL | 2 | 1 | 1 tab |
| 2 | Natural Language Post-Mortems | M | 1 | inline | 1 component |
| 3 | Multi-Strategy Conflict Detection | L | 1 | 1 | 1 component |
| 4 | Shadow Mode | L | 0 | 1 subcollection | 1 tab |
| 5 | Monte Carlo Risk Simulation | XL | 1 | 1 | 1 screen |
| 6 | "What Is The Bot Thinking?" | M | 0 | 0 | 1 screen |
| 7 | Replay Mode | L | 1 | 1 | 1 screen |
| 8 | Earnings Calendar (IBKR) | M | 1 | 1 | 1 component |
| 9 | Macro Calendar + Viewer | L | 1 | 1 | 1 screen |

---

## Feature 1: Strategy Performance Autopilot

### What it does

Claude periodically reviews a strategy's recent trade history and proposes concrete,
actionable modifications — updated rules, threshold adjustments, new conditions —
with an explanation of why. The user reviews a diff-style summary and accepts,
rejects, or modifies each proposed change. Accepted changes are applied immediately
and logged to the strategy's change history.

This is not a flag-for-review. It is a specific, executable proposal: "Change
RSI threshold from 30 to 38" or "Add a MACD confirmation condition to the buy rule."

### When it runs

A Cloud Scheduler job (`autopilotAnalysis`) runs once per week per strategy that:
- Has been active for at least 14 days
- Has at least 10 completed trades
- Is not archived

The user can also trigger it manually from the strategy detail screen.

### Firestore Schema Additions

```
// Subcollection under each strategy
users/{userId}/strategies/{strategyId}/autopilotReports/{reportId}

  reportId: string
  strategyId: string                    // denormalised
  userId: string                        // denormalised

  // Analysis window
  periodStart: timestamp
  periodEnd: timestamp
  tradesAnalysed: number
  cyclesAnalysed: number

  // Performance summary Claude was given
  performanceSummary: {
    winRate: number
    avgWinUsd: number
    avgLossUsd: number
    profitFactor: number | null
    sharpeRatio: number | null
    maxDrawdownPct: number
    totalRealizedPnlUsd: number
    avgHoldingPeriodMs: number
    signalFrequency: number             // avg trades per week
    inactiveCyclesPct: number           // % of cycles where no rule triggered
    commonLossPatterns: string[]        // e.g. ["RSI reversal after entry", "held through earnings"]
  }

  // Claude's proposed changes
  proposals: [
    {
      proposalId: string
      type: 'modify_rule' | 'add_rule' | 'remove_rule' | 'adjust_threshold'
            | 'add_condition' | 'change_position_sizing'
      targetRuleId: string | null       // which rule to modify (null for new rules)
      description: string               // plain English: what changes and why
      before: string | null             // current rule condition/action
      after: string | null              // proposed rule condition/action
      expectedImpact: string            // Claude's prediction of what this changes
      confidence: number                // 0-1: how confident Claude is in this suggestion
      dataEvidence: string              // what in the trade history supports this
    }
  ]

  claudeRawResponse: string
  promptVersion: string

  // User decisions
  status: 'pending' | 'reviewed' | 'applied' | 'rejected'
  reviewedAt: timestamp | null
  appliedAt: timestamp | null
  appliedProposalIds: string[]          // which proposals the user accepted
  rejectedProposalIds: string[]

  generatedAt: timestamp
  expireAt: timestamp                   // [TTL] 90 days
```

### Cloud Function: `autopilotAnalysis`

```javascript
exports.autopilotAnalysis = onSchedule({
  schedule: 'every monday 06:00',      // runs weekly, low-traffic time
  timeZone: 'UTC',
  timeoutSeconds: 300,
  memory: '512MiB',
}, async () => {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  // Find eligible strategies
  const strategies = await db.collectionGroup('strategies')
    .where('status', 'in', ['active', 'paused'])
    .where('createdAt', '<', twoWeeksAgo)
    .get();

  for (const doc of strategies.docs) {
    const strategy = doc.data();
    try {
      await runAutopilotForStrategy(strategy);
    } catch (err) {
      await logError({ source: 'autopilot', severity: 'warning',
        userId: strategy.userId, strategyId: strategy.strategyId,
        message: err.message });
    }
  }
});

async function runAutopilotForStrategy(strategy) {
  const { userId, strategyId } = strategy;

  // Load recent trades (last 90 days, max 200)
  const trades = await db
    .collection(`users/${userId}/strategies/${strategyId}/trades`)
    .where('isClosingTrade', '==', true)
    .where('executedAt', '>', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
    .orderBy('executedAt', 'desc')
    .limit(200)
    .get();

  if (trades.size < 10) return;  // not enough data

  // Load recent cycles (for inactivity analysis)
  const cycles = await db
    .collection(`users/${userId}/strategies/${strategyId}/cycles`)
    .where('startedAt', '>', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    .orderBy('startedAt', 'desc')
    .limit(500)
    .get();

  // Build performance summary
  const tradeData = trades.docs.map(d => d.data());
  const cycleData  = cycles.docs.map(d => d.data());
  const summary    = buildPerformanceSummary(tradeData, cycleData);

  // Skip if no actionable signal
  if (summary.tradesAnalysed < 10) return;

  // Call Claude
  const prompt = buildAutopilotPrompt(strategy, summary, tradeData);
  const { content, usage } = await callClaude(prompt);
  const parsed = parseClaudeJSON(content, autopilotReportSchema);

  if (!parsed.ok || !parsed.data.proposals?.length) return;

  // Save report
  const reportId = `${Date.now()}_${nanoid(6)}`;
  await db.doc(`users/${userId}/strategies/${strategyId}/autopilotReports/${reportId}`)
    .set({
      reportId, strategyId, userId,
      periodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      periodEnd: new Date(),
      tradesAnalysed: tradeData.length,
      cyclesAnalysed: cycleData.length,
      performanceSummary: summary,
      proposals: parsed.data.proposals,
      claudeRawResponse: content,
      promptVersion: PROMPT_VERSIONS.AUTOPILOT,
      status: 'pending',
      reviewedAt: null, appliedAt: null,
      appliedProposalIds: [], rejectedProposalIds: [],
      generatedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    });

  // Notify user
  await sendNotification(userId, 'autopilot_report_ready', strategy, {
    proposalCount: parsed.data.proposals.length,
    reportId
  });
}
```

### Claude Prompt: `buildAutopilotPrompt`

```
System:
You are an expert algorithmic trading coach reviewing the performance of an
automated strategy and proposing concrete improvements.

You must propose SPECIFIC, ACTIONABLE changes — not vague suggestions.
Every proposal must include the exact before/after rule text using the strategy's DSL.

Respond ONLY with valid JSON. Schema:
{
  "summary": string,            // 2-3 sentence diagnosis of the strategy's performance
  "proposals": [
    {
      "proposalId": string,     // short slug e.g. "raise_rsi_threshold"
      "type": "modify_rule" | "add_rule" | "remove_rule" | "adjust_threshold"
              | "add_condition" | "change_position_sizing",
      "targetRuleId": string | null,
      "description": string,    // plain English for the user
      "before": string | null,  // current DSL text
      "after": string | null,   // proposed DSL text
      "expectedImpact": string, // what outcome this is designed to improve
      "confidence": number,     // 0-1
      "dataEvidence": string    // specific numbers from trade history supporting this
    }
  ]
}

Limit to 3 proposals maximum. Only propose changes supported by clear evidence
in the data. If the strategy is performing well, propose 0-1 minor optimisations.
If you have no evidence-backed proposals, return an empty proposals array.

User:
Strategy name: {strategy.name}
Current mode: {strategy.decisionMode}
Current rules:
{strategy.rules.map(r => `  [${r.ruleId}] IF ${r.condition} THEN ${r.action}`).join('\n')}

Performance over last 30 days:
- Trades: {summary.tradesAnalysed} ({summary.winRate.toFixed(1)}% win rate)
- Avg win: ${summary.avgWinUsd.toFixed(2)} | Avg loss: ${summary.avgLossUsd.toFixed(2)}
- Profit factor: {summary.profitFactor?.toFixed(2) ?? 'n/a'}
- Max drawdown: {summary.maxDrawdownPct.toFixed(1)}%
- Total P&L: ${summary.totalRealizedPnlUsd.toFixed(2)}
- Inactive cycles: {summary.inactiveCyclesPct.toFixed(1)}% (no rule triggered)
- Avg holding period: {formatDuration(summary.avgHoldingPeriodMs)}

Loss patterns observed:
{summary.commonLossPatterns.map(p => `  - ${p}`).join('\n')}

Last 10 closed trades (newest first):
{tradeData.slice(0, 10).map(t =>
  `  ${t.side.toUpperCase()} ${t.symbol} | Entry: $${t.executedPriceUsd?.toFixed(4)} | ` +
  `P&L: ${t.realizedPnlPct?.toFixed(2)}% | Held: ${formatDuration(t.holdingPeriodMs)} | ` +
  `Rule: ${t.rulesTriggered?.join(', ') ?? 'autonomous'}`
).join('\n')}

Propose concrete improvements. Base every suggestion on evidence in the data above.
```

### Cloud Function: `applyAutopilotProposals` (HTTPS callable)

```javascript
exports.applyAutopilotProposals = onCall(async (request) => {
  const { strategyId, reportId, acceptedProposalIds } = request.data;
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', '');

  await enforceRateLimit(userId, 'apply_autopilot', 5, 3600);

  const reportRef = db.doc(
    `users/${userId}/strategies/${strategyId}/autopilotReports/${reportId}`);
  const report = (await reportRef.get()).data();

  if (!report || report.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Report not found or already reviewed');
  }

  const accepted = report.proposals.filter(
    p => acceptedProposalIds.includes(p.proposalId));
  const rejected = report.proposals.filter(
    p => !acceptedProposalIds.includes(p.proposalId));

  // Apply each accepted proposal to the strategy's rules
  const stratRef = db.doc(`users/${userId}/strategies/${strategyId}`);
  const strategy = (await stratRef.get()).data();
  let rules = [...strategy.rules];

  for (const proposal of accepted) {
    rules = applyProposalToRules(rules, proposal);
  }

  // Write updated rules + mark report as applied
  await db.runTransaction(async tx => {
    tx.update(stratRef, {
      rules,
      updatedAt: FieldValue.serverTimestamp(),
      descriptionHistory: FieldValue.arrayUnion({
        text: strategy.description,
        updatedAt: new Date(),
        claudeSummary: `Autopilot applied: ${accepted.map(p => p.description).join('; ')}`
      })
    });
    tx.update(reportRef, {
      status: 'applied',
      appliedAt: FieldValue.serverTimestamp(),
      appliedProposalIds: acceptedProposalIds,
      rejectedProposalIds: rejected.map(p => p.proposalId)
    });
  });

  return { applied: accepted.length, rejected: rejected.length };
});
```

### Flutter UI

New tab in StrategyDetailScreen: **"Autopilot"** (4th tab, shown only when a report exists).

```
┌────────────────────────────────────────────────────┐
│ 🤖 Weekly Autopilot Review                        │
│ Based on 23 trades from the last 30 days           │
│                                                    │
│ "Win rate is healthy at 61%, but the strategy is  │
│  inactive 78% of cycles — RSI rarely hits 30.     │
│  Two rule changes could improve signal frequency." │
├────────────────────────────────────────────────────┤
│ Proposal 1 of 2                [Accept] [Reject]  │
│                                                    │
│ Raise RSI buy threshold: 30 → 38                  │
│                                                    │
│ BEFORE: RSI_14 < 30                               │
│ AFTER:  RSI_14 < 38                               │
│                                                    │
│ Why: RSI reached 30 only 3 times in 30 days.      │
│  RSI 38 would have triggered 11 times with a      │
│  similar win rate (8/11 = 73% historically).      │
│                                                    │
│ Confidence: ████████░░  0.78                      │
├────────────────────────────────────────────────────┤
│ Proposal 2 of 2                [Accept] [Reject]  │
│ ...                                               │
├────────────────────────────────────────────────────┤
│     [Apply accepted changes]                       │
└────────────────────────────────────────────────────┘
```

Pending report badge on strategy card: small ✨ indicator when a new report exists.

---

## Feature 2: Natural Language Post-Mortems

### What it does

After any trade that closes with a loss exceeding 2% of portfolio value, or any
stop-loss trigger, Claude automatically generates a plain-English post-mortem:
what happened, why the signal was right or wrong, what market context was missed,
and what could be done differently. This appears as a special entry in the
reasoning feed and triggers a push notification.

For winning trades above 5% P&L, a brief "What went right" summary is also generated.

### When it runs

Triggered inside `executeOrSimulate()` immediately after a closing trade is logged.
A separate asynchronous Cloud Function `generatePostMortem` is enqueued via a
Firestore write (not called inline — don't slow down the trade loop).

### Firestore Schema Additions

Add `postMortem` field to the existing trade document:

```
// Added to users/{userId}/strategies/{strategyId}/trades/{tradeId}

postMortem: {
  generated: boolean
  generatedAt: timestamp | null
  type: 'loss_analysis' | 'win_analysis' | null
  summary: string | null               // 80-150 word narrative
  whatHappened: string | null          // 1-2 sentences: the mechanics
  signalQuality: string | null         // was the entry signal actually good?
  missedContext: string[] | null       // what Claude wishes it had known
  lessonsForStrategy: string[] | null  // 1-3 concrete takeaways
  promptVersion: string | null
  claudeTokens: number | null
  claudeCostUsd: number | null
} | null
```

Trigger document (enqueues post-mortem generation without blocking trade loop):

```
postMortemQueue/{tradeId}

  tradeId: string
  userId: string
  strategyId: string
  cycleId: string
  type: 'loss_analysis' | 'win_analysis'
  createdAt: timestamp
  processed: boolean
  processedAt: timestamp | null
  expireAt: timestamp                  // [TTL] 24 hours
```

### Cloud Function: `postMortemProcessor`

```javascript
// Triggered by Firestore onWrite on postMortemQueue
exports.postMortemProcessor = onDocumentCreated(
  'postMortemQueue/{tradeId}',
  async (event) => {
    const { tradeId, userId, strategyId, cycleId, type } = event.data.data();

    // Load all context
    const [tradeDoc, cycleDoc, strategyDoc] = await Promise.all([
      db.doc(`users/${userId}/strategies/${strategyId}/trades/${tradeId}`).get(),
      db.doc(`users/${userId}/strategies/${strategyId}/cycles/${cycleId}`).get(),
      db.doc(`users/${userId}/strategies/${strategyId}`).get(),
    ]);

    const trade    = tradeDoc.data();
    const cycle    = cycleDoc.data();
    const strategy = strategyDoc.data();

    // Load opening trade for context (for sells)
    let openingTrade = null;
    if (trade.openingTradeIds?.length > 0) {
      const openingDoc = await db.doc(
        `users/${userId}/strategies/${strategyId}/trades/${trade.openingTradeIds[0]}`
      ).get();
      openingTrade = openingDoc.data();
    }

    const prompt = buildPostMortemPrompt(trade, cycle, strategy, openingTrade, type);
    const { content, usage } = await callClaude(prompt);
    const parsed = parseClaudeJSON(content, postMortemSchema);

    if (!parsed.ok) {
      await event.data.ref.update({ processed: true, processedAt: FieldValue.serverTimestamp() });
      return;
    }

    // Write post-mortem back to the trade document
    await db.doc(`users/${userId}/strategies/${strategyId}/trades/${tradeId}`)
      .update({
        'postMortem.generated': true,
        'postMortem.generatedAt': FieldValue.serverTimestamp(),
        'postMortem.type': type,
        'postMortem.summary': parsed.data.summary,
        'postMortem.whatHappened': parsed.data.whatHappened,
        'postMortem.signalQuality': parsed.data.signalQuality,
        'postMortem.missedContext': parsed.data.missedContext,
        'postMortem.lessonsForStrategy': parsed.data.lessonsForStrategy,
        'postMortem.promptVersion': PROMPT_VERSIONS.POST_MORTEM,
        'postMortem.claudeTokens': usage.input_tokens + usage.output_tokens,
        'postMortem.claudeCostUsd': estimateCost(usage),
      });

    // Mark queue item processed
    await event.data.ref.update({ processed: true, processedAt: FieldValue.serverTimestamp() });

    // Send push notification
    const emoji = type === 'loss_analysis' ? '📉' : '📈';
    await sendNotification(userId, 'post_mortem_ready', strategy, {
      tradeId, type,
      preview: parsed.data.summary.slice(0, 80)
    });
  }
);
```

### How to enqueue from the trade loop

In `executeOrSimulate()`, after writing the closing trade document, add:

```javascript
// Enqueue post-mortem if loss > 2% or stop-loss triggered, or win > 5%
const pnlPct = trade.realizedPnlPct ?? 0;
const isSignificantLoss = pnlPct < -2.0 || trade.source === 'stop_loss';
const isSignificantWin  = pnlPct > 5.0;

if (isSignificantLoss || isSignificantWin) {
  await db.collection('postMortemQueue').doc(tradeId).set({
    tradeId, userId, strategyId,
    cycleId: trade.cycleId,
    type: isSignificantLoss ? 'loss_analysis' : 'win_analysis',
    createdAt: FieldValue.serverTimestamp(),
    processed: false,
    expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
}
```

### Claude Prompt: `buildPostMortemPrompt`

```
System:
You are an analytical trading coach. A trade just closed and you are writing
a clear, honest post-mortem to help the trader learn from it.

Be specific with numbers. Be honest — if the entry signal was actually good
but the market moved against it randomly, say so. If the signal was weak and
the trade should never have been placed, say that too.

Keep the total response under 200 words across all fields.

Respond ONLY with valid JSON:
{
  "summary": string,              // 80-150 words narrative: the full story of this trade
  "whatHappened": string,         // 1-2 sentences: mechanics (entry, what market did, exit)
  "signalQuality": string,        // was the entry signal genuinely good? honest assessment
  "missedContext": string[],      // 1-3 things that, if known, would have changed the decision
  "lessonsForStrategy": string[]  // 1-3 concrete, actionable takeaways for the strategy rules
}

User:
Trade: {trade.side.toUpperCase()} {trade.symbol}
Entry: ${openingTrade?.executedPriceUsd?.toFixed(4) ?? 'unknown'}
  at {openingTrade ? formatDate(openingTrade.executedAt) : 'unknown'}
  Signal: {openingTrade?.claudeReasoning ?? 'n/a'}

Exit: ${trade.executedPriceUsd?.toFixed(4)} at {formatDate(trade.executedAt)}
  Source: {trade.source}  ({trade.source === 'stop_loss' ? 'stop-loss triggered' : 'strategy signal'})
  P&L: {trade.realizedPnlPct?.toFixed(2)}%  (${trade.realizedPnlUsd?.toFixed(2)})
  Held: {formatDuration(trade.holdingPeriodMs)}

Market conditions at entry:
{formatMarketSnapshotForPostMortem(cycle?.marketSnapshot, trade.symbol)}

Market conditions at exit:
(Fear & Greed: {cycle?.marketSnapshot?.fearGreedIndex ?? 'n/a'} — {cycle?.marketSnapshot?.fearGreedLabel ?? 'n/a'})
{cycle?.marketSnapshot?.newsHeadlines?.map(h => `  • ${h}`).join('\n') ?? 'No news data'}

Strategy intent: {strategy.claudeSummary}

Write an honest post-mortem.
```

### Flutter UI

In TradeDetailScreen, if `postMortem.generated == true`, show a post-mortem card:

```
┌────────────────────────────────────────────────────┐
│ 📉 Post-Mortem Analysis                           │
├────────────────────────────────────────────────────┤
│ "RSI hit 28.4 and Fear & Greed was at 23, both    │
│  strong buy signals under this strategy. BTC      │
│  dropped a further 4.2% over the next 6 hours     │
│  before recovering. This wasn't a bad signal —    │
│  markets can extend oversold conditions for        │
│  hours. The stop-loss worked as designed."         │
├────────────────────────────────────────────────────┤
│ Signal quality                                     │
│ "The entry signal was textbook — RSI and F&G      │
│  both aligned. The loss was timing, not logic."   │
├────────────────────────────────────────────────────┤
│ What could have helped                             │
│ • BTC had rejected this price level 3 times       │
│   in the prior 48h (resistance, not support)      │
│ • Volume was declining on the move down            │
├────────────────────────────────────────────────────┤
│ Lessons for strategy                               │
│ • Consider adding volume confirmation to RSI buy  │
│ • Check if price is near a recent resistance level│
└────────────────────────────────────────────────────┘
```

In the reasoning feed, post-mortems appear as a distinct entry type (purple,
📉 or 📈 icon) below the closing trade entry.

---

## Feature 3: Multi-Strategy Conflict Detection

### What it does

Before the trade loop executes any trade, it checks whether other active strategies
targeting the same asset have a conflicting pending signal. "Conflicting" means:
one strategy wants to BUY while another wants to SELL the same asset on the same
broker account. When a conflict is detected, both trades are held and the user is
notified to resolve it manually, OR the system applies a configurable
auto-resolution rule.

### Conflict Detection Logic

```javascript
// Run at start of each trade loop batch, before individual strategies execute
async function detectAndResolveConflicts(eligibleStrategies) {
  // Group strategies by (broker, symbol) pairs where a trade is pending
  const pendingSignals = {};

  // First pass: compute decisions without executing
  const decisions = await Promise.all(
    eligibleStrategies.map(async strategy => ({
      strategy,
      preview: await previewDecision(strategy)  // runs Claude but doesn't execute
    }))
  );

  // Find conflicts: same broker + same symbol + opposing sides
  const conflicts = [];
  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      const a = decisions[i];
      const b = decisions[j];

      if (a.preview.action !== 'buy' && a.preview.action !== 'sell') continue;
      if (b.preview.action !== 'buy' && b.preview.action !== 'sell') continue;

      const sameBroker = a.strategy.assets.broker === b.strategy.assets.broker;
      const sameSymbol = a.preview.symbol === b.preview.symbol;
      const opposingSides = a.preview.side !== b.preview.side;

      if (sameBroker && sameSymbol && opposingSides) {
        conflicts.push({
          conflictId: nanoid(8),
          strategyA: { id: a.strategy.strategyId, name: a.strategy.name, decision: a.preview },
          strategyB: { id: b.strategy.strategyId, name: b.strategy.name, decision: b.preview },
          symbol: a.preview.symbol,
          broker: a.strategy.assets.broker,
          detectedAt: new Date()
        });
      }
    }
  }

  return { decisions, conflicts };
}
```

### Auto-Resolution Rules (configurable per user)

Stored in `users/{userId}.conflictResolution`:

```javascript
conflictResolution: {
  rule: 'hold_both'          // default: hold both trades, notify user
       | 'higher_confidence' // execute the trade with higher Claude confidence
       | 'older_strategy'    // execute the trade from the older strategy
       | 'newer_strategy'    // execute the trade from the newer strategy
}
```

### Firestore: Conflict Log

```
users/{userId}/conflictLogs/{conflictId}

  conflictId: string
  userId: string
  symbol: string
  broker: string
  strategyAId: string
  strategyAName: string
  strategyADecision: { action, side, notionalUsd, reasoning, confidence }
  strategyBId: string
  strategyBName: string
  strategyBDecision: { action, side, notionalUsd, reasoning, confidence }
  resolutionRule: string
  resolution: 'held_both' | 'executed_a' | 'executed_b'
  resolutionReason: string
  detectedAt: timestamp
  resolvedAt: timestamp
  expireAt: timestamp        // [TTL] 30 days
```

### Flutter UI

**Conflict notification:** Push notification immediately on detection:
"⚔️ Strategy conflict on BTC: RSI Scalper wants to BUY while Momentum wants to SELL.
Both held — tap to resolve."

**Conflict resolution bottom sheet:**

```
┌────────────────────────────────────────────────────┐
│ ⚔️ Strategy Conflict Detected                     │
│ Both strategies want to trade BTC at the same time │
├────────────────────────────────────────────────────┤
│ RSI Scalper wants to BUY $15.00 BTC               │
│ "RSI 28.4, F&G 23 — strong oversold signal"       │
│ Confidence: 0.81                                   │
├────────────────────────────────────────────────────┤
│ Momentum wants to SELL $12.00 BTC                  │
│ "MACD crossover bearish, EMA20 below EMA50"        │
│ Confidence: 0.63                                   │
├────────────────────────────────────────────────────┤
│ [Execute RSI Scalper] [Execute Momentum] [Hold both]│
│                                                    │
│ Auto-resolve future conflicts:  [Hold both ▼]     │
└────────────────────────────────────────────────────┘
```

Conflict history accessible in Settings → Conflict Log.

---

## Feature 4: Shadow Mode

### What it does

Shadow mode runs alongside a live strategy. Every cycle, it simulates what a
*different* configuration would have done against the real prices — allowing the
user to compare their live strategy against a variation without risking real money.
Think of it as A/B testing strategies in parallel.

Also used as the mandatory pre-live validation stage: when a paper strategy is
being considered for going live, shadow mode shows its projected live performance
against actual market prices for the last 24 hours before the switch is authorised.

### How it differs from paper mode

Paper mode IS the strategy, running in simulation.
Shadow mode runs ALONGSIDE a live strategy — a separate shadow config that
tracks what would have happened. It doesn't affect live trades.

### Firestore Schema

```
// Subcollection under an existing strategy
users/{userId}/strategies/{strategyId}/shadowConfigs/{shadowId}

  shadowId: string
  strategyId: string              // parent strategy
  userId: string
  name: string                    // e.g. "RSI 38 variant"
  description: string

  // Override config (only fields that differ from parent strategy)
  overrides: {
    rules: Rule[] | null          // replace all rules (rule_interpreter mode)
    riskOverrides: {
      maxLossPerTradePct: number | null
      stopLossPerTradePct: number | null
      takeProfitPerTradePct: number | null
    } | null
    decisionModeOverride: 'rule_interpreter' | 'autonomous_reasoner' | null
  }

  status: 'active' | 'paused' | 'completed'
  startedAt: timestamp
  endedAt: timestamp | null

  // Rolling performance vs parent
  stats: {
    totalShadowTrades: number
    shadowWinCount: number
    shadowLossCount: number
    shadowTotalPnlUsd: number
    parentTotalPnlUsd: number      // parent strategy P&L over same period (snapshot)
    outperforming: boolean         // shadow beating parent?
    lastUpdatedAt: timestamp | null
  }

// Shadow trade documents (simulated, like paper trades)
users/{userId}/strategies/{strategyId}/shadowTrades/{tradeId}

  // Same structure as regular trades, plus:
  shadowId: string
  parentCycleId: string           // which parent cycle this shadow ran alongside
  parentDecision: string          // what the parent strategy decided (for comparison)
  expireAt: timestamp             // [TTL] 30 days
```

### Trade Loop Integration

In `runStrategyLoop`, after the main cycle completes, run shadow configs in parallel:

```javascript
// After main cycle completes — fire-and-forget (don't await, don't block)
const shadowConfigs = await db
  .collection(`users/${userId}/strategies/${strategyId}/shadowConfigs`)
  .where('status', '==', 'active')
  .get();

if (shadowConfigs.size > 0) {
  // Don't await — shadow runs async in background
  runShadowCycles(strategy, portfolioSnapshot, marketSnapshot, cycleId,
    shadowConfigs.docs.map(d => d.data()))
    .catch(err => logError({ source: 'shadow_mode', severity: 'warning',
      userId, strategyId, message: err.message }));
}
```

### Flutter UI

**Shadow mode tab** in StrategyDetailScreen (5th tab, shown only if shadow configs exist):

```
┌────────────────────────────────────────────────────┐
│ 👥 Shadow Mode                   [+ Add Shadow]   │
├────────────────────────────────────────────────────┤
│ RSI 38 Variant         (14 days)  [Active] [Stop] │
│                                                    │
│ Live strategy P&L:   +$4.20  (21%)                │
│ Shadow variant P&L:  +$7.80  (39%) ↑ +86% better │
│                                                    │
│ Shadow: 18 trades, 67% win rate                   │
│ Live:   11 trades, 55% win rate                   │
│                                                    │
│ [Promote shadow to live strategy →]               │
├────────────────────────────────────────────────────┤
│ Conservative stops       (7 days) [Paused]        │
│ ...                                               │
└────────────────────────────────────────────────────┘
```

"Promote shadow to live strategy" → copies shadow's override config into the parent
strategy's rules. Requires hold-to-confirm (2s). Original rules saved to `descriptionHistory`.

---

## Feature 5: Monte Carlo Risk Simulation

### What it does

Before a strategy goes live, the user can run a Monte Carlo simulation to understand
the range of possible outcomes. The simulation uses the strategy's paper trade
history (or manually entered parameters) to run 1,000 simulated paths and shows
the distribution of outcomes: expected value, 5th percentile (worst case), and
95th percentile (best case).

Critically: this shows not just "average return" but the full distribution, including
the probability of ruin (losing > X% of the starting portfolio).

### How it works

Monte Carlo is CPU-intensive. It runs entirely in a Cloud Function invoked on demand
(not scheduled). The Flutter app shows a loading state while it runs (~5–10 seconds).

### Firestore Schema

```
users/{userId}/strategies/{strategyId}/monteCarloResults/{resultId}

  resultId: string
  strategyId: string
  userId: string

  // Simulation parameters
  startingCapitalUsd: number
  simulationPeriodDays: number         // e.g. 90
  simulationCount: number              // always 1000
  tradesPerPeriod: number              // estimated from history
  winRate: number
  avgWinPct: number
  avgLossPct: number
  stdDevWinPct: number
  stdDevLossPct: number

  // Results distribution (percentile buckets)
  results: {
    p5FinalValueUsd: number            // worst 5% outcome
    p25FinalValueUsd: number
    p50FinalValueUsd: number           // median
    p75FinalValueUsd: number
    p95FinalValueUsd: number           // best 5% outcome
    meanFinalValueUsd: number

    probabilityOfRuin20Pct: number     // P(loss > 20%) over period
    probabilityOfRuin50Pct: number
    maxDrawdownDistribution: {         // histogram of max drawdowns across simulations
      buckets: number[]                // e.g. [0,5,10,15,20,25,30] pct boundaries
      counts: number[]                 // count of simulations in each bucket
    }
    equityCurves: number[][]           // sample of 20 paths for chart (not all 1000)
    returnsHistogram: {
      buckets: number[]                // final return % boundaries
      counts: number[]
    }
  }

  generatedAt: timestamp
  dataSource: 'paper_trades' | 'manual_params'
  tradesUsedForParams: number
  expireAt: timestamp                  // [TTL] 7 days
```

### Cloud Function: `runMonteCarlo` (HTTPS callable)

```javascript
exports.runMonteCarlo = onCall({
  timeoutSeconds: 120,
  memory: '1GiB',
}, async (request) => {
  const { strategyId, startingCapitalUsd, periodDays } = request.data;
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', '');

  await enforceRateLimit(userId, 'monte_carlo', 5, 3600);

  // Load paper trade history (need at least 20 trades for meaningful params)
  const trades = await db
    .collection(`users/${userId}/strategies/${strategyId}/trades`)
    .where('isClosingTrade', '==', true)
    .where('mode', '==', 'paper')
    .orderBy('executedAt', 'desc')
    .limit(200)
    .get();

  const tradeData = trades.docs.map(d => d.data());

  let params;
  if (tradeData.length >= 20) {
    params = deriveParamsFromTrades(tradeData);
  } else {
    // Fall back to user-supplied or default conservative params
    params = {
      winRate: 0.50,
      avgWinPct: 0.03,
      avgLossPct: -0.02,
      stdDevWinPct: 0.02,
      stdDevLossPct: 0.01,
      tradesPerPeriod: estimateTradesPerPeriod(tradeData, periodDays)
    };
  }

  // Run 1000 Monte Carlo simulations
  const results = runSimulations({
    startingCapital: startingCapitalUsd,
    periodDays,
    simulationCount: 1000,
    ...params
  });

  // Save and return
  const resultId = `${Date.now()}_${nanoid(6)}`;
  await db.doc(`users/${userId}/strategies/${strategyId}/monteCarloResults/${resultId}`)
    .set({
      resultId, strategyId, userId,
      startingCapitalUsd, simulationPeriodDays: periodDays,
      simulationCount: 1000,
      ...params,
      results,
      generatedAt: FieldValue.serverTimestamp(),
      dataSource: tradeData.length >= 20 ? 'paper_trades' : 'manual_params',
      tradesUsedForParams: tradeData.length,
      expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

  return { resultId, results, params };
});

function runSimulations({ startingCapital, periodDays, simulationCount,
  winRate, avgWinPct, avgLossPct, stdDevWinPct, stdDevLossPct, tradesPerPeriod }) {

  const finalValues = [];
  const maxDrawdowns = [];
  const sampleCurves = [];
  const tradesTotal = Math.round(tradesPerPeriod * (periodDays / 30));

  for (let sim = 0; sim < simulationCount; sim++) {
    let capital = startingCapital;
    let peak = startingCapital;
    let maxDD = 0;
    const curve = [startingCapital];

    for (let t = 0; t < tradesTotal; t++) {
      const isWin = Math.random() < winRate;

      // Sample from normal distribution around mean win/loss
      const pct = isWin
        ? avgWinPct   + (gaussianRandom() * stdDevWinPct)
        : avgLossPct  + (gaussianRandom() * stdDevLossPct);

      capital = capital * (1 + pct);
      capital = Math.max(capital, 0);  // floor at 0

      if (capital > peak) peak = capital;
      const dd = (peak - capital) / peak;
      if (dd > maxDD) maxDD = dd;

      if (t % 5 === 0) curve.push(capital);  // sample every 5 trades for curve
    }

    finalValues.push(capital);
    maxDrawdowns.push(maxDD * 100);
    if (sim < 20) sampleCurves.push(curve);
  }

  finalValues.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const pct = (arr, p) => arr[Math.floor(arr.length * p)];

  return {
    p5FinalValueUsd:   pct(finalValues, 0.05),
    p25FinalValueUsd:  pct(finalValues, 0.25),
    p50FinalValueUsd:  pct(finalValues, 0.50),
    p75FinalValueUsd:  pct(finalValues, 0.75),
    p95FinalValueUsd:  pct(finalValues, 0.95),
    meanFinalValueUsd: finalValues.reduce((a, b) => a + b, 0) / finalValues.length,
    probabilityOfRuin20Pct: finalValues.filter(v => v < startingCapital * 0.8).length / simulationCount,
    probabilityOfRuin50Pct: finalValues.filter(v => v < startingCapital * 0.5).length / simulationCount,
    maxDrawdownDistribution: buildHistogram(maxDrawdowns, [0,5,10,15,20,25,30,40,50,100]),
    equityCurves: sampleCurves,
    returnsHistogram: buildHistogram(
      finalValues.map(v => ((v - startingCapital) / startingCapital) * 100),
      [-50,-40,-30,-20,-10,-5,0,5,10,20,30,40,50,100]
    )
  };
}

function gaussianRandom() {
  // Box-Muller transform
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

### Flutter UI: Monte Carlo Screen

Accessible from the strategy detail screen via "Risk Analysis" button (shown on paper strategies before going live, and always accessible from strategy overflow menu).

```
┌────────────────────────────────────────────────────┐
│ 🎲 Risk Simulation                                 │
│ 1,000 simulated paths · 90 days · $20 starting     │
├────────────────────────────────────────────────────┤
│ Based on your 23 paper trades:                     │
│   Win rate: 61%  |  Avg win: +3.2%  |  Avg loss: -2.1%
├────────────────────────────────────────────────────┤
│         Projected outcomes after 90 days           │
│                                                    │
│  Best 5%    $38.40  (+92%)  ████████████████████  │
│  75th pct   $26.10  (+31%)  ████████████          │
│  Median     $22.80  (+14%)  ████████              │
│  25th pct   $18.40   (-8%)  ██████                │
│  Worst 5%   $11.20  (-44%)  ████                  │
├────────────────────────────────────────────────────┤
│         Probability of loss                        │
│  Lose > 20%:   18%  ██░░░░░░░░                    │
│  Lose > 50%:    4%  █░░░░░░░░░                    │
├────────────────────────────────────────────────────┤
│         20 sample equity curves                    │
│ [line chart — fl_chart — spaghetti of 20 paths]   │
├────────────────────────────────────────────────────┤
│         Return distribution                        │
│ [histogram: final return % across all 1000 sims]  │
├────────────────────────────────────────────────────┤
│ ⚠️ This simulation uses your paper trade history  │
│ as a proxy. Past results do not guarantee future  │
│ performance.                                       │
│                                [Re-run simulation] │
└────────────────────────────────────────────────────┘
```

---

## Feature 6: "What Is The Bot Thinking Right Now?"

### What it does

A dedicated live screen showing the current indicator values for every watched asset,
colour-coded against the strategy's rule thresholds. Users can see exactly how far
each asset is from triggering a signal — a "signal proximity" gauge. No new data
fetched: reads from the most recent cycle document in Firestore.

This is entirely a Flutter UI feature — zero new Cloud Functions required.
The trade loop already stores all indicator values in cycle documents.

### Flutter UI: Live Signal Screen

Accessible from the StrategyDetailScreen header as a live indicator button (📡).

```
┌────────────────────────────────────────────────────┐
│ 📡 Live Signals · BTC RSI Scalper                 │
│ Data from last cycle: 4 min ago · Next: 11 min    │
│                                            [↺ Now] │
├────────────────────────────────────────────────────┤
│ BTCUSDT                          $63,450           │
│                                                    │
│ RSI(14)     48.2  ████████████████░░░░  → need <30 │
│             [════════════════●────────]            │
│              0              48.2     30 (trigger) │
│                                                    │
│ MACD hist  +0.0018  Bullish momentum               │
│ EMA20     $63,100   Price above ✓                  │
│ EMA50     $62,800   Price above ✓                  │
│ EMA200    $58,400   Price above ✓ (uptrend)        │
│ F&G Index     41   Neutral                         │
├────────────────────────────────────────────────────┤
│ ETHUSDT                           $3,224           │
│                                                    │
│ RSI(14)     31.2  ██████░░░░░░░░░░░░░░  → need <30 │
│             [══════●══════════────────]            │
│              0   31.2              30 (trigger)   │
│             ⚠️  Getting close!                     │
│                                                    │
│ MACD hist  -0.0004  Slight bearish                 │
│ EMA200    $3,050    Price above ✓ (uptrend)        │
├────────────────────────────────────────────────────┤
│ Rules currently watching:                          │
│ ⏳ rsi_oversold_uptrend_buy (BTC) — RSI 18.2 away │
│ ⚡ rsi_oversold_uptrend_buy (ETH) — RSI 1.2 away  │
│    (likely triggers next cycle if RSI holds)       │
└────────────────────────────────────────────────────┘
```

Colour coding:
- Green: condition met (trigger)
- Amber: within 20% of threshold (getting close)
- Blue: neutral, monitoring
- Red: condition met in wrong direction (e.g. RSI too high for buy)

"[↺ Now]" triggers a manual cycle run (calls `manualCycleTrigger` Cloud Function,
rate limited 3/min).

The screen auto-refreshes whenever a new cycle document is written to Firestore
(Firestore real-time listener on `lastCycleId`).

**Rule proximity text** at the bottom shows for each rule: how far each condition
variable is from its trigger threshold. Human-readable: "RSI 1.2 points away from
triggering."

---

## Feature 7: Replay Mode

### What it does

The user picks a date range and watches the strategy play out against real historical
data in accelerated time — seeing the reasoning feed, indicator states, and trade
decisions cycle by cycle, as if watching a recording. Not backtesting (no
performance stats are generated). Pure visual playback for learning and debugging.

### How it works

A Cloud Function fetches historical OHLCV data for the date range, runs the full
indicator pipeline and Claude decision logic on each historical time step,
and stores the results as a replaySession document. The Flutter app then plays
back the session like a video — step forward/backward, adjust speed.

### Firestore Schema

```
users/{userId}/strategies/{strategyId}/replaySessions/{sessionId}

  sessionId: string
  strategyId: string
  userId: string

  // Parameters
  startDate: timestamp
  endDate: timestamp
  intervalMinutes: number             // 15 by default

  // Status
  status: 'generating' | 'ready' | 'error'
  progress: number                    // 0-100 during generation
  totalSteps: number
  completedSteps: number
  generatedAt: timestamp | null

  // Results (array of steps, each is like a cycle doc)
  // Stored as a separate subcollection for large date ranges
  expireAt: timestamp                 // [TTL] 7 days
```

```
users/{userId}/strategies/{strategyId}/replaySessions/{sessionId}/steps/{stepIndex}

  stepIndex: number                   // 0, 1, 2, ...
  timestamp: timestamp                // the historical time this step represents
  marketSnapshot: { ... }            // same structure as cycle marketSnapshot
  portfolioSnapshot: { ... }         // simulated portfolio state
  decision: { ... }                  // Claude's decision
  tradeExecuted: boolean
  trade: { ... } | null
  claudeCalled: boolean
  claudeCostUsd: number
```

### Cloud Function: `generateReplaySession` (HTTPS callable)

```javascript
exports.generateReplaySession = onCall({
  timeoutSeconds: 540,
  memory: '1GiB',
}, async (request) => {
  const { strategyId, startDate, endDate } = request.data;
  const userId = request.auth?.uid;

  await enforceRateLimit(userId, 'replay_session', 3, 86400);  // 3 per day

  const sessionId = `${Date.now()}_${nanoid(6)}`;
  const sessionRef = db.doc(
    `users/${userId}/strategies/${strategyId}/replaySessions/${sessionId}`);

  // Initialise session
  await sessionRef.set({
    sessionId, strategyId, userId,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    intervalMinutes: 15,
    status: 'generating',
    progress: 0,
    totalSteps: 0,
    completedSteps: 0,
    generatedAt: null,
    expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });

  const strategy = (await db.doc(`users/${userId}/strategies/${strategyId}`).get()).data();

  // Fetch historical OHLCV for all assets
  const allCandles = {};
  for (const symbol of strategy.assets.watchlist) {
    allCandles[symbol] = await fetchHistoricalOHLCV(
      strategy.assets.broker, userId, symbol, startDate, endDate, '15m');
  }

  // Determine time steps
  const timeSteps = generateTimeSteps(startDate, endDate, 15);
  await sessionRef.update({ totalSteps: timeSteps.length });

  // Simulate portfolio
  let simulatedPortfolio = {
    totalValueUsd: 20,  // start with $20 (or user's actual starting balance)
    cashUsd: 20,
    positions: []
  };

  for (let i = 0; i < timeSteps.length; i++) {
    const stepTime = timeSteps[i];

    // Build market snapshot at this time step using historical data
    const marketSnapshot = buildHistoricalMarketSnapshot(
      allCandles, stepTime, strategy.assets.watchlist);

    if (marketSnapshot.dataStale) {
      // Skip this step (market closed or data missing)
      continue;
    }

    // Get Claude decision (uses real Claude — this is why it's rate-limited)
    const claudeResult = await getClaudeDecision(
      strategy, simulatedPortfolio, marketSnapshot);

    const { decision } = validateDecision(claudeResult.decision, strategy, simulatedPortfolio);

    // Simulate trade execution
    let trade = null;
    if (decision.action === 'buy' || decision.action === 'sell') {
      trade = simulateTrade(decision, marketSnapshot, simulatedPortfolio);
      simulatedPortfolio = updateSimulatedPortfolio(simulatedPortfolio, trade);
    }

    // Write step
    await sessionRef.collection('steps').doc(String(i).padStart(6, '0')).set({
      stepIndex: i, timestamp: stepTime,
      marketSnapshot, portfolioSnapshot: { ...simulatedPortfolio },
      decision, tradeExecuted: trade !== null, trade,
      claudeCalled: claudeResult.claudeCalled,
      claudeCostUsd: claudeResult.costUsd
    });

    // Update progress
    if (i % 10 === 0) {
      await sessionRef.update({
        progress: Math.round((i / timeSteps.length) * 100),
        completedSteps: i
      });
    }
  }

  await sessionRef.update({
    status: 'ready', progress: 100,
    completedSteps: timeSteps.length,
    generatedAt: FieldValue.serverTimestamp()
  });

  return { sessionId };
});
```

### Flutter UI: Replay Screen

Accessible from strategy detail screen overflow menu → "Replay historical period".

```
┌────────────────────────────────────────────────────┐
│ ⏪ Replay Mode · BTC RSI Scalper                  │
│ Dec 1 – Dec 14, 2025  (96 steps)                  │
├────────────────────────────────────────────────────┤
│ [equity curve chart — shows portfolio value]       │
│ ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━     │
│ Step 34/96  · Dec 9, 08:00 UTC                    │
│                                                    │
│ ⏮  ◀◀  ⏸/▶  ▶▶  ⏭    Speed: [1x ▼]             │
├────────────────────────────────────────────────────┤
│ 🟢 BUY  BTCUSDT  $12.00  conf: 0.81              │
│ "RSI at 29.1, F&G 21. Oversold + uptrend.         │
│  Buying 0.00019 BTC at $61,200."                  │
├────────────────────────────────────────────────────┤
│ Market at this step                                │
│ BTC  $61,200  RSI 29.1  MACD –0.002               │
│ F&G  21 (Extreme Fear)                            │
├────────────────────────────────────────────────────┤
│ Portfolio at this step                             │
│ Cash: $8.00  |  BTC: $12.00  |  Total: $20.00     │
└────────────────────────────────────────────────────┘
```

Playback controls:
- ▶/⏸ — play / pause (auto-advances through steps at selected speed)
- ◀◀/▶▶ — previous/next step
- ⏮/⏭ — first/last step
- Speed: 1×, 2×, 5×, 10× (controls Flutter animation timer interval)
- Click any point on equity curve → jump to that step

---

## Feature 8: Earnings Calendar (IBKR Strategies)

### What it does

For every stock in an IBKR strategy's watchlist, the system fetches upcoming
earnings dates. Before any trade in the 7 days prior to an earnings event,
Claude is explicitly warned. The user can configure an "earnings blackout" —
automatically skip trades within N days of an earnings report.

### Data Source

Financial Modeling Prep API (free tier: 250 requests/day).
Earnings dates for any US stock: `https://financialmodelingprep.com/api/v3/earning_calendar`

### Firestore Schema

```
earningsCalendar/{symbol}_{YYYY-MM-DD}

  symbol: string
  earningsDate: timestamp
  fiscalQuarter: string               // e.g. "Q3 2025"
  estimatedEPS: number | null
  actualEPS: number | null            // null until reported
  reportTime: 'bmo' | 'amc' | null   // before/after market open
  source: string
  fetchedAt: timestamp
  expireAt: timestamp                 // [TTL] 7 days after earningsDate
```

### Cloud Function: `refreshEarningsCalendar`

Scheduled daily at 06:00 UTC. Fetches next 14 days of earnings for all symbols
across all active IBKR strategies.

```javascript
exports.refreshEarningsCalendar = onSchedule({
  schedule: 'every day 06:00',
  timeZone: 'UTC',
  timeoutSeconds: 120,
}, async () => {
  // Collect all unique IBKR symbols across all active strategies
  const strategies = await db.collectionGroup('strategies')
    .where('status', '==', 'active')
    .where('assets.broker', '==', 'ibkr')
    .get();

  const symbols = new Set();
  strategies.docs.forEach(d => {
    (d.data().assets?.watchlist ?? []).forEach(s => symbols.add(s));
  });

  if (symbols.size === 0) return;

  const apiKey = await getSecret('fmp_api_key');
  const symbolList = Array.from(symbols).join(',');
  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const url = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const events = await resp.json();

  const batch = db.batch();
  for (const event of events) {
    if (!symbols.has(event.symbol)) continue;
    const docId = `${event.symbol}_${event.date}`;
    batch.set(db.doc(`earningsCalendar/${docId}`), {
      symbol: event.symbol,
      earningsDate: new Date(event.date),
      fiscalQuarter: event.fiscalDateEnding ?? null,
      estimatedEPS: event.epsEstimated ?? null,
      actualEPS: event.eps ?? null,
      reportTime: event.time ?? null,
      source: 'fmp',
      fetchedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(new Date(event.date).getTime() + 7 * 24 * 60 * 60 * 1000)
    });
  }
  await batch.commit();
});
```

### Trade Loop Integration

In `fetchMarketData()`, for IBKR strategies, enrich each asset with earnings context:

```javascript
async function getEarningsContext(symbol, daysAhead = 14) {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const events = await db.collection('earningsCalendar')
    .where('symbol', '==', symbol)
    .where('earningsDate', '>=', now)
    .where('earningsDate', '<=', future)
    .orderBy('earningsDate')
    .limit(1)
    .get();

  if (events.empty) return null;

  const event = events.docs[0].data();
  const daysUntil = Math.ceil(
    (event.earningsDate.toDate() - now) / (24 * 60 * 60 * 1000));

  return {
    earningsDate: event.earningsDate,
    daysUntil,
    reportTime: event.reportTime,
    fiscalQuarter: event.fiscalQuarter,
    warningLevel: daysUntil <= 2 ? 'critical'
                : daysUntil <= 7 ? 'warning'
                : 'info'
  };
}
```

Add `earningsContext` field to each asset in `marketSnapshot.assets[]`.

In the autonomous Claude prompt, inject earnings warnings:

```javascript
// In buildAutonomousPrompt, for each asset:
${asset.earningsContext
  ? `⚠️ EARNINGS: ${asset.symbol} reports ${asset.earningsContext.fiscalQuarter} ` +
    `in ${asset.earningsContext.daysUntil} day(s) ` +
    `(${asset.earningsContext.reportTime === 'bmo' ? 'before market open' : 'after market close'}). ` +
    `Factor elevated volatility risk into your decision.`
  : ''
}
```

### Strategy Setting: Earnings Blackout

Add to strategy risk config:

```
risk.earningsBlackoutDays: number    // 0 = disabled, 1-14 = skip trades N days before earnings
```

In the validation layer, if `earningsContext.daysUntil <= risk.earningsBlackoutDays`:

```javascript
if (strategy.risk.earningsBlackoutDays > 0 &&
    assetEarningsContext?.daysUntil <= strategy.risk.earningsBlackoutDays) {
  return hold(`Earnings blackout: ${decision.symbol} reports in ` +
    `${assetEarningsContext.daysUntil} day(s). Blackout active for ` +
    `${strategy.risk.earningsBlackoutDays} days.`);
}
```

### Flutter UI

Earnings indicator on the "What Is The Bot Thinking?" screen:

```
AAPL    $189.40
RSI(14)  52.1  ████████████░░░░░░  neutral
⚠️ Earnings in 3 days (BMO) — blackout active
```

Dedicated **Earnings Calendar tab** in the IBKR strategy detail screen
showing all upcoming earnings for the watchlist in a calendar view.

---

## Feature 9: Macro Calendar + Viewer

### What it does

The system tracks major macroeconomic events (Fed meetings, CPI releases, NFP,
FOMC minutes, ECB decisions, etc.) and shows them in a dedicated calendar screen.
The trade loop is aware of upcoming macro events and Claude is warned before
high-impact events. Users can configure a "macro blackout" window (e.g. 24 hours
before and 2 hours after a high-impact event).

### Data Source

Forex Factory Economic Calendar via scraping OR a dedicated economic calendar API.
Best option: **Tradingeconomics.com API** (paid, accurate) or **Alpha Vantage
Economic Indicators** (free, limited). For the initial version: parse the public
FMP economic calendar endpoint (same API key as earnings).

```
GET https://financialmodelingprep.com/api/v3/economic_calendar
    ?from=YYYY-MM-DD&to=YYYY-MM-DD&apikey={key}
```

### Firestore Schema

```
macroCalendar/{eventId}

  eventId: string                     // {date}_{eventName_slug}
  eventName: string                   // e.g. "Federal Reserve Interest Rate Decision"
  shortName: string                   // e.g. "Fed Rate Decision"
  country: string                     // "US", "EU", "UK", etc.
  eventDate: timestamp
  eventTime: string | null            // "14:00 UTC"
  impact: 'low' | 'medium' | 'high'  // estimated market impact
  currency: string                    // affected currency e.g. "USD"
  actual: string | null               // populated after event
  forecast: string | null
  previous: string | null
  unit: string | null                 // e.g. "%" or "bps"
  source: string
  fetchedAt: timestamp
  expireAt: timestamp                 // [TTL] 7 days after eventDate

// High-impact events also written here for fast trade-loop queries
upcomingHighImpactEvents/{eventId}
  // Same fields — pruned to only high-impact events within next 48h
  // Updated daily by refreshMacroCalendar
  expireAt: timestamp                 // [TTL] eventDate + 4 hours
```

### Cloud Function: `refreshMacroCalendar`

Scheduled daily at 05:00 UTC. Fetches next 14 days of economic events.

```javascript
exports.refreshMacroCalendar = onSchedule({
  schedule: 'every day 05:00',
  timeZone: 'UTC',
  timeoutSeconds: 60,
}, async () => {
  const apiKey = await getSecret('fmp_api_key');  // reuse same key as earnings
  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const events = await resp.json();

  const batch = db.batch();
  const highImpactBatch = db.batch();

  for (const event of events) {
    const impact = classifyImpact(event);
    const eventDate = new Date(event.date);
    const eventId = `${event.date}_${slugify(event.event)}`;

    const doc = {
      eventId,
      eventName: event.event,
      shortName: abbreviateEventName(event.event),
      country: event.country,
      eventDate,
      eventTime: event.time ?? null,
      impact,
      currency: event.currency ?? null,
      actual: event.actual ?? null,
      forecast: event.estimate ?? null,
      previous: event.previous ?? null,
      unit: event.unit ?? null,
      source: 'fmp',
      fetchedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(eventDate.getTime() + 7 * 24 * 60 * 60 * 1000)
    };

    batch.set(db.doc(`macroCalendar/${eventId}`), doc);

    // Also write high-impact events to fast-access collection
    const hoursUntil = (eventDate - Date.now()) / (1000 * 60 * 60);
    if (impact === 'high' && hoursUntil >= 0 && hoursUntil <= 48) {
      highImpactBatch.set(db.doc(`upcomingHighImpactEvents/${eventId}`), {
        ...doc,
        expireAt: new Date(eventDate.getTime() + 4 * 60 * 60 * 1000)  // expires 4h after event
      });
    }
  }

  await batch.commit();
  await highImpactBatch.commit();
});

function classifyImpact(event) {
  const highImpactKeywords = [
    'federal reserve', 'interest rate', 'fomc', 'cpi', 'inflation',
    'nonfarm payroll', 'gdp', 'ecb', 'bank of england', 'unemployment'
  ];
  const name = event.event.toLowerCase();
  if (highImpactKeywords.some(k => name.includes(k))) return 'high';
  if (event.impact === 'High' || event.impact === '3') return 'high';
  if (event.impact === 'Medium' || event.impact === '2') return 'medium';
  return 'low';
}
```

### Trade Loop Integration

In `enrichWithExternalData()`, add macro event awareness:

```javascript
async function getUpcomingMacroEvents(hoursAhead = 24) {
  const cutoff = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  const events = await db.collection('upcomingHighImpactEvents')
    .where('eventDate', '<=', cutoff)
    .where('eventDate', '>=', new Date())
    .orderBy('eventDate')
    .get();

  return events.docs.map(d => d.data());
}
```

In the autonomous prompt, inject macro context:

```javascript
${upcomingEvents.length > 0
  ? `⚠️ HIGH-IMPACT MACRO EVENTS IN NEXT 24 HOURS:\n` +
    upcomingEvents.map(e =>
      `  • ${e.shortName} (${e.country}) at ${e.eventTime ?? e.eventDate.toISOString()} UTC — ` +
      `Forecast: ${e.forecast ?? 'n/a'}, Previous: ${e.previous ?? 'n/a'}`
    ).join('\n') +
    `\nFactor potential market volatility into your decision.`
  : ''
}
```

### Strategy Setting: Macro Blackout

```
risk.macroBlackoutHoursBefore: number   // 0 = disabled, 1-48h before high-impact event
risk.macroBlackoutHoursAfter: number    // 0 = disabled, 1-12h after event (dust settling)
```

Validation layer check:

```javascript
const nextHighImpactEvent = upcomingEvents.find(e => e.impact === 'high');
if (nextHighImpactEvent && strategy.risk.macroBlackoutHoursBefore > 0) {
  const hoursUntil = (nextHighImpactEvent.eventDate.toDate() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil <= strategy.risk.macroBlackoutHoursBefore) {
    return hold(
      `Macro blackout: ${nextHighImpactEvent.shortName} in ${hoursUntil.toFixed(1)}h. ` +
      `Blackout window: ${strategy.risk.macroBlackoutHoursBefore}h before.`
    );
  }
}
```

### Flutter UI: Macro Calendar Screen

Accessible from: main bottom nav (new tab), and from the Live Signals screen.

```
┌────────────────────────────────────────────────────┐
│ 📅 Macro Calendar                   [This week ▼] │
├────────────────────────────────────────────────────┤
│ TODAY — Thursday 15 Jan                            │
│                                                    │
│ 🔴 14:00 UTC  Fed Interest Rate Decision (US)     │
│    Forecast: 4.25%  |  Previous: 4.50%            │
│    ████████████████████████ HIGH IMPACT            │
│    [2 of your strategies have blackout active]     │
│                                                    │
│ 🟡 16:30 UTC  Initial Jobless Claims (US)          │
│    Forecast: 218K  |  Previous: 221K               │
│    ████████░░░░░░░░ MEDIUM IMPACT                 │
├────────────────────────────────────────────────────┤
│ TOMORROW — Friday 16 Jan                           │
│                                                    │
│ 🔴 13:30 UTC  Nonfarm Payrolls (US)               │
│    Forecast: 165K  |  Previous: 227K               │
│    ████████████████████████ HIGH IMPACT            │
│                                                    │
│ 🟢 09:00 UTC  German ZEW Economic Sentiment (EU)  │
│    Forecast: 42.0  |  Previous: 41.5              │
│    ████░░░░░░░░░░░░ LOW IMPACT                    │
├────────────────────────────────────────────────────┤
│ NEXT WEEK                                          │
│ Mon  13:00 UTC  UK CPI (UK)            🔴 HIGH    │
│ Wed  15:00 UTC  Crude Oil Inventories  🟡 MED     │
│ Thu  14:00 UTC  ECB Rate Decision      🔴 HIGH    │
└────────────────────────────────────────────────────┘
```

**Past events** (today and earlier) show actual vs forecast with colour:
- Green if actual better than forecast
- Red if actual worse than forecast

**Affected strategies indicator:** each high-impact event shows how many of the
user's strategies have a blackout window covering that event.

**Notification:** 2 hours before any high-impact event, send FCM notification:
"📅 Fed Rate Decision in 2 hours. 2 strategies are in blackout mode."

---

## Firestore Index Additions

```
// Autopilot reports
collectionGroup: autopilotReports
  userId ASC, status ASC, generatedAt DESC

// Conflict logs
collection: users/{userId}/conflictLogs
  detectedAt DESC

// Replay sessions
collectionGroup: replaySessions
  userId ASC, strategyId ASC, generatedAt DESC

// Monte Carlo results
collectionGroup: monteCarloResults
  userId ASC, strategyId ASC, generatedAt DESC

// Earnings calendar
collection: earningsCalendar
  symbol ASC, earningsDate ASC

// Macro calendar
collection: macroCalendar
  impact ASC, eventDate ASC
  country ASC, eventDate ASC

// upcoming high-impact events
collection: upcomingHighImpactEvents
  eventDate ASC
```

---

## New External API Keys Needed

| Secret name | Service | Used for | Free tier |
|---|---|---|---|
| `fmp_api_key` | Financial Modeling Prep | Earnings + macro calendar | 250 req/day |

Add to Google Cloud Secret Manager alongside existing keys.

FMP free tier (250 req/day) is sufficient: earnings refresh runs once daily
fetching ~30 symbols; macro calendar runs once daily. Combined: ~60 requests/day.

---

## Implementation Order Additions

Add these tasks after Phase 9 (Admin Dashboard) in `09-implementation-order.md`:

### Phase 10.5: New Features (in order)

| Task | Feature | Complexity |
|---|---|---|
| 10.5.1 | Live Signals screen (Flutter only — no backend) | M |
| 10.5.2 | FMP API key + `refreshEarningsCalendar` CF | S |
| 10.5.3 | `refreshMacroCalendar` CF + Macro Calendar screen | M |
| 10.5.4 | Earnings context in trade loop + blackout validation | M |
| 10.5.5 | Macro context in Claude prompts + blackout validation | M |
| 10.5.6 | `postMortemProcessor` CF + trade UI card | M |
| 10.5.7 | Conflict detection in trade loop batch + UI | L |
| 10.5.8 | Shadow mode schema + trade loop integration + UI | L |
| 10.5.9 | `runMonteCarlo` CF + Monte Carlo screen | L |
| 10.5.10 | `generateReplaySession` CF + Replay screen | XL |
| 10.5.11 | `autopilotAnalysis` CF + Autopilot tab in strategy | XL |
