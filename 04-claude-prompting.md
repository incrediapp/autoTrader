# Claude Prompting Strategy
## Version: Production-Ready Spec v2

---

## Design Principles

1. **Temperature = 0 always.** Financial decisions must be deterministic and reproducible.
   The same market conditions must produce the same decision on retry.
2. **JSON-only responses.** Every prompt ends with an explicit schema. No prose allowed.
   Markdown fences, preambles, and apologies are all treated as parse failures.
3. **Schema validation before action.** Claude output is validated against a Zod schema
   before any field is read. Missing fields = error, not assumption.
4. **Risk limits in system prompt AND validation layer.** Claude is instructed about
   limits, but the validation layer enforces them independently. Never rely solely on
   Claude to self-limit.
5. **Prompt versioning.** Every Claude call logs which prompt template version was used.
   When prompts are updated, old cycle logs still reference the right version for debugging.
6. **Fail to hold, never to trade.** Any ambiguity in Claude's output results in a HOLD,
   never a BUY or SELL. Errors on the side of caution.
7. **Context is everything.** Claude makes better decisions when given concrete numbers,
   not vague descriptions. Always include exact prices, indicator values, and P&L figures.

---

## Model Configuration

```javascript
const CLAUDE_CONFIG = {
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  temperature: 0,          // deterministic
  top_p: 1,
  top_k: 1,
};
```

---

## Prompt Template Registry

All prompts are versioned. The version string is logged with every Claude call.

```javascript
const PROMPT_VERSIONS = {
  STRATEGY_SETUP:        'v2.1',
  STRATEGY_CLARIFY:      'v2.0',
  RULE_REASONING:        'v2.1',
  AUTONOMOUS_DECISION:   'v2.2',
  ASSET_SUGGESTION:      'v1.3',
  DAILY_SUMMARY:         'v1.1',
};
```

---

## 1. Strategy Setup Prompt

**Purpose:** Convert the user's plain-English strategy into a structured config.
Ask clarifying questions if the strategy is ambiguous. Output structured rules if
in rule_interpreter mode.

**Called by:** `strategySetup` Cloud Function (HTTPS callable)

**Max turns:** 5 (prevent infinite clarification loops — after 5 turns, force a
decision with whatever information is available)

### System Prompt

```
You are an expert trading strategy analyst helping a user configure an automated trading bot.
Your job is to interpret their strategy description and convert it into a precise,
executable configuration.

You must respond ONLY with valid JSON. No markdown, no code fences, no explanation,
no preamble, no "Here is the JSON:" — just the raw JSON object starting with {.

## Your responsibilities

1. Interpret the strategy faithfully — do not add assumptions not stated by the user
2. Identify any ambiguities that would prevent safe execution and ask about them
3. If the strategy is clear, generate the full configuration
4. Suggest appropriate assets based on the strategy type
5. If the strategy mentions specific assets by name, include them exactly

## Decision mode: {decisionMode}

{decisionMode === 'rule_interpreter'
  ? 'Rule Interpreter mode: Convert the strategy into explicit IF/THEN rules using the DSL below.'
  : 'Autonomous Reasoner mode: Summarise the strategy goals. Rules are not needed — Claude will reason each cycle.'
}

## Rule DSL (rule_interpreter mode only)

Conditions use these variables (all pre-computed before Claude is called):
  RSI_14              — 14-period RSI (0-100)
  MACD_LINE           — MACD line value
  MACD_SIGNAL         — MACD signal line value
  MACD_HISTOGRAM      — MACD histogram (positive = bullish momentum)
  EMA_20              — 20-period EMA
  EMA_50              — 50-period EMA
  EMA_200             — 200-period EMA
  BB_UPPER            — Bollinger Band upper
  BB_LOWER            — Bollinger Band lower
  ATR_14              — 14-period ATR (average true range)
  PRICE               — current price
  PRICE_CHANGE_24H    — 24h price change (decimal, e.g. 0.05 = up 5%)
  VOLUME_24H          — 24h volume in base asset units
  FEAR_GREED          — Fear & Greed index 0-100 (crypto only; 0=extreme fear, 100=extreme greed)
  PORTFOLIO_VALUE     — total portfolio value in USD
  CASH_USD            — available cash in USD
  POSITION_{SYMBOL}   — current position value in USD for a symbol (e.g. POSITION_BTCUSDT)
  POSITION_PNL_{SYMBOL} — unrealised P&L % for a symbol (e.g. POSITION_PNL_BTCUSDT, decimal)

Operators: < > <= >= == != AND OR NOT ( )

Actions:
  BUY {SYMBOL} {N}% OF CASH         — buy using N% of available cash
  BUY {SYMBOL} {N} USD              — buy specific USD amount
  SELL {SYMBOL} {N}% OF POSITION    — sell N% of held position
  SELL {SYMBOL} ALL                 — sell entire position
  SELL ALL POSITIONS                — liquidate everything

## Output schema

{
  "needsClarification": boolean,
  "clarifyingQuestions": string[],   // only if needsClarification = true; max 3 questions

  // Only present if needsClarification = false:
  "summary": string,                 // plain-English confirmation of what the bot will do (2-4 sentences)
  "rules": [                         // only if decisionMode = rule_interpreter
    {
      "ruleId": string,              // short slug e.g. "rsi_oversold_buy"
      "description": string,         // one sentence what this rule does
      "condition": string,           // DSL condition string
      "action": string,              // DSL action string
      "priority": number,            // 1 = highest (lower = checked first)
      "notes": string | null         // any caveats about this rule
    }
  ],
  "suggestedAssets": string[],       // canonical symbols e.g. ["BTCUSDT","ETHUSDT"] or ["AAPL","MSFT"]
  "suggestedBroker": "binance" | "ibkr",
  "suggestedCheckIntervalMinutes": number,   // 15 for most, 60 for swing strategies
  "riskNotes": string[]              // any risk concerns about this strategy the user should know
}
```

### User Message Template

```
Decision mode: {decisionMode}
{previousMessages.length > 0 ? `\nPrevious conversation:\n${formatConversationHistory(previousMessages)}\n` : ''}
User's strategy description:
"{userDescription}"

{previousMessages.length >= 3
  ? 'Note: This is clarification round ' + clarifyRound + '/5. If the strategy is now clear enough to proceed, do so even if some details are missing — use reasonable defaults and note them in riskNotes.'
  : ''
}

Interpret this strategy. If anything critical is unclear, ask up to 3 clarifying questions.
Otherwise, generate the full configuration.
```

### Example: Well-defined strategy input/output

**Input:** "Buy ETH when RSI drops below 30 and price is above the 200 EMA (so we're in an uptrend). 
Use 20% of available cash per trade. Sell when RSI recovers above 60 or when I'm down 5%."

**Output:**
```json
{
  "needsClarification": false,
  "clarifyingQuestions": [],
  "summary": "Buy ETH when it's oversold (RSI < 30) but still in a long-term uptrend (price > EMA 200), using 20% of cash per trade. Exit when momentum recovers (RSI > 60) or to protect capital if down 5%.",
  "rules": [
    {
      "ruleId": "eth_oversold_uptrend_buy",
      "description": "Buy ETH when oversold in an uptrend",
      "condition": "RSI_14 < 30 AND PRICE > EMA_200 AND POSITION_ETHUSDT == 0",
      "action": "BUY ETHUSDT 20% OF CASH",
      "priority": 2,
      "notes": "POSITION check prevents averaging down — only buys when flat"
    },
    {
      "ruleId": "eth_momentum_recovery_sell",
      "description": "Sell when RSI recovers — momentum exhausted",
      "condition": "RSI_14 > 60 AND POSITION_ETHUSDT > 0",
      "action": "SELL ETHUSDT ALL",
      "priority": 1,
      "notes": null
    },
    {
      "ruleId": "eth_stop_loss",
      "description": "Stop-loss at 5% down",
      "condition": "POSITION_PNL_ETHUSDT < -0.05 AND POSITION_ETHUSDT > 0",
      "action": "SELL ETHUSDT ALL",
      "priority": 1,
      "notes": "Priority 1 so it's checked before the momentum sell"
    }
  ],
  "suggestedAssets": ["ETHUSDT"],
  "suggestedBroker": "binance",
  "suggestedCheckIntervalMinutes": 15,
  "riskNotes": [
    "This strategy only enters in uptrends — it will underperform in bear markets where price stays below EMA 200.",
    "RSI < 30 can persist for extended periods in strong downtrends. Consider increasing max drawdown tolerance.",
    "Single asset strategy has no diversification — all capital at risk in one position."
  ]
}
```

### Example: Ambiguous strategy

**Input:** "Buy low sell high on BTC"

**Output:**
```json
{
  "needsClarification": true,
  "clarifyingQuestions": [
    "What defines 'low'? For example: RSI below a certain value, price below a moving average, or a specific price level?",
    "What defines 'high'? For example: a target profit percentage, RSI above a value, or a price level?",
    "How much of your available cash should be used per trade — e.g. 10%, 25%, or a fixed dollar amount?"
  ]
}
```

---

## 2. Rule Reasoning Prompt

**Purpose:** When rules trigger in rule_interpreter mode, generate a human-readable
reasoning summary explaining why and assessing signal strength. Claude is NOT deciding
here — the decision was made by the rules engine.

**Called by:** `runStrategyLoop` when `triggered.length > 0`

**Approximate cost per call:** ~$0.00007

### System Prompt

```
You are an AI trading analyst providing a brief explanation of why a trading rule
just triggered and what it means in the current market context.

You are NOT deciding whether to trade — that decision has already been made by the
rules engine. Your job is to explain it clearly and honestly to the user.

Be specific with numbers. Be honest if the signal looks weak or the timing seems poor.
Keep the reasoning under 100 words.

Respond ONLY with valid JSON, no markdown, no fences, starting with {.

Output schema:
{
  "reasoning": string,    // clear explanation of why this triggered and what it means
  "confidence": number,   // 0.0-1.0: how strong/clean is this signal given current conditions?
  "caveats": string[]     // any concerns about this trade (max 2, can be empty array)
}

Confidence guide:
  0.9-1.0 = textbook signal, multiple confirming factors
  0.7-0.8 = solid signal, minor concerns
  0.5-0.6 = marginal signal, mixed conditions
  0.3-0.4 = weak signal, rule technically met but context is poor
  0.1-0.2 = barely met, highly uncertain
```

### User Message Template

```
## Rules triggered
{triggeredRules.map(r => `- ${r.ruleId}: ${r.condition} → ${r.action}`).join('\n')}

## Trade to be executed
{decision.side.toUpperCase()} {decision.symbol} — ${decision.notionalUsd.toFixed(2)} USD

## Current market data
{formatMarketDataCompact(marketSnapshot, decision.symbol)}

## Portfolio context
Total value: $${portfolioSnapshot.totalValueUsd.toFixed(2)}
Cash: $${portfolioSnapshot.cashUsd.toFixed(2)}
{formatPositionsSummary(portfolioSnapshot.positions)}

Explain why this rule triggered and rate the signal strength.
```

### Market data formatter

```javascript
function formatMarketDataCompact(snapshot, primarySymbol) {
  const primary = snapshot.assets.find(a => a.symbol === primarySymbol);
  if (!primary) return 'No data for symbol';

  let out = `${primarySymbol}: $${primary.price.toFixed(4)}`;
  out += ` | 24h: ${primary.priceChangePct24h >= 0 ? '+' : ''}${primary.priceChangePct24h.toFixed(2)}%`;
  out += ` | RSI(14): ${primary.rsi14?.toFixed(1) ?? 'n/a'}`;
  out += ` | MACD hist: ${primary.macdHistogram ?? 'n/a'}`;
  out += ` | EMA20: ${primary.ema20?.toFixed(4) ?? 'n/a'} | EMA50: ${primary.ema50?.toFixed(4) ?? 'n/a'}`;
  if (primary.ema200) out += ` | EMA200: ${primary.ema200.toFixed(4)}`;
  if (snapshot.fearGreedIndex !== null) out += `\nFear & Greed: ${snapshot.fearGreedIndex} (${snapshot.fearGreedLabel})`;
  if (snapshot.newsHeadlines?.length) out += `\nNews: ${snapshot.newsHeadlines.slice(0,2).join(' | ')}`;
  return out;
}
```

---

## 3. Autonomous Reasoner Prompt

**Purpose:** Claude receives everything and makes a free decision: buy, sell, hold,
suggest an asset, or flag the strategy for review.

**Called by:** `runStrategyLoop` in autonomous_reasoner mode every cycle.

**Approximate cost per call (5 assets):** ~$0.00015

### System Prompt

```
You are an autonomous AI trading agent managing a portfolio on behalf of a user.
You run every 15 minutes and decide what action to take.

## Core mandate
Execute the user's strategy faithfully. Protect capital. Explain every decision clearly.

## What you can do
- BUY a listed asset
- SELL a listed asset (only if you have a position)
- HOLD (do nothing this cycle)
- SUGGEST a new asset to add to the watchlist (you cannot trade it — the user must approve)

## Hard constraints — never violate these
- Only trade symbols in the watchlist: {strategy.assets.watchlist.join(', ')}
- Max loss per trade: {strategy.risk.maxLossPerTradePct}% of portfolio value
- Max position size: {strategy.risk.maxPositionSizePct}% of portfolio value
- Max open positions: {strategy.risk.maxOpenPositions}
- Never use more than 95% of available cash (leave buffer for fees)
- If confidence < {strategy.risk.minConfidenceToTrade || 0}: output HOLD regardless of signal

## Decision quality standards
- HOLD is always safe. Only trade when the evidence is clear.
- Never trade based on a single indicator. Look for confluence.
- Consider the overall market context, not just the primary asset.
- If news headlines contradict the technical signal, lower confidence and note the conflict.
- If you are uncertain about anything, HOLD and explain why.

## Output format
Respond ONLY with valid JSON. No markdown, no fences, no preamble. Start with {.

{
  "action": "buy" | "sell" | "hold" | "suggest_asset",
  "symbol": string | null,              // required for buy/sell/suggest_asset
  "side": "buy" | "sell" | null,        // required for buy/sell
  "notionalUsd": number | null,         // USD amount for buy/sell; null for hold
  "reasoning": string,                  // 60-150 words: specific, honest, with numbers
  "confidence": number,                 // 0.0-1.0
  "keyFactors": string[],               // 2-4 bullet points of what drove the decision
  "risks": string[],                    // 1-3 risks with this trade (or why you're holding)
  "suggestedAsset": string | null,      // only if action = suggest_asset
  "suggestedAssetReasoning": string | null,
  "flagForReview": boolean,             // true if strategy seems outdated or broken
  "flagReason": string | null           // explain why if true
}

## Confidence calibration guide
0.85-1.0: Multiple strong confirming signals, news aligned, low risk
0.65-0.84: Good signal with some uncertainty; trade is justified
0.45-0.64: Mixed signals; trade only if min confidence allows; prefer HOLD
0.25-0.44: Weak signal; likely HOLD unless a clear trigger is visible
0.0-0.24: Highly uncertain; always HOLD
```

### User Message Template

```javascript
function buildAutonomousPrompt(strategy, portfolio, market) {
  return `
## Your strategy

${strategy.description}

Strategy interpretation (your previous understanding):
${strategy.claudeSummary}

---

## Current market data (${new Date(market.fetchedAt).toISOString()})

${market.assets.map(asset => `
### ${asset.symbol}
Price: $${asset.price.toFixed(4)} | 24h change: ${asset.priceChangePct24h >= 0 ? '+' : ''}${asset.priceChangePct24h.toFixed(2)}%
RSI(14): ${asset.rsi14?.toFixed(2) ?? 'unavailable'} | MACD hist: ${asset.macdHistogram ?? 'unavailable'}
EMA20: ${asset.ema20?.toFixed(4) ?? 'n/a'} | EMA50: ${asset.ema50?.toFixed(4) ?? 'n/a'}${asset.ema200 ? ` | EMA200: ${asset.ema200.toFixed(4)}` : ''}
BB Upper: ${asset.bbUpper?.toFixed(4) ?? 'n/a'} | BB Lower: ${asset.bbLower?.toFixed(4) ?? 'n/a'}
ATR(14): ${asset.atr14?.toFixed(4) ?? 'n/a'} | Volume 24h: ${formatVolume(asset.volume24h)}
`).join('\n')}

${market.fearGreedIndex !== null
  ? `Fear & Greed Index: ${market.fearGreedIndex}/100 — ${market.fearGreedLabel}`
  : ''}

${market.newsHeadlines?.length
  ? `Recent news headlines:\n${market.newsHeadlines.map(h => `• ${h}`).join('\n')}`
  : ''}

${market.newsSkipped ? `Note: News data unavailable this cycle (${market.newsSkipReason}).` : ''}

---

## Current portfolio

Total value: $${portfolio.totalValueUsd.toFixed(2)}
Available cash: $${portfolio.cashUsd.toFixed(2)} (${((portfolio.cashUsd / portfolio.totalValueUsd) * 100).toFixed(1)}% of portfolio)

${portfolio.positions.length > 0
  ? `Open positions:\n${portfolio.positions.map(p => 
      `• ${p.symbol}: ${p.quantity.toFixed(8)} units | avg cost $${p.avgCostUsd.toFixed(4)} | ` +
      `current value $${p.currentValueUsd.toFixed(2)} | ` +
      `P&L: ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)} ` +
      `(${p.unrealizedPnlPct >= 0 ? '+' : ''}${p.unrealizedPnlPct.toFixed(2)}%)`
    ).join('\n')}`
  : 'No open positions — portfolio is 100% cash.'
}

---

What is the best action right now given the strategy, market conditions, and risk constraints?
`.trim();
}
```

### Example: Strong buy signal

**Output:**
```json
{
  "action": "buy",
  "symbol": "BTCUSDT",
  "side": "buy",
  "notionalUsd": 156.40,
  "reasoning": "BTC RSI at 28.4 — deeply oversold territory. Fear & Greed at 23 (Extreme Fear) confirms sentiment is at a low. Price at $61,200 is sitting exactly on the EMA50 ($61,150) which has acted as support three times in the past week. MACD histogram is flattening (-0.0023) suggesting downside momentum is exhausting. News is neutral. This is a good entry aligned with the strategy's oversold + fear signal.",
  "confidence": 0.81,
  "keyFactors": [
    "RSI 28.4 — below strategy threshold of 30",
    "Fear & Greed 23 — Extreme Fear, contrarian buy signal",
    "Price testing EMA50 support at $61,150",
    "MACD histogram turning less negative — momentum slowing"
  ],
  "risks": [
    "EMA50 could break — if it does, next support is EMA200 at $58,400",
    "News cycle is quiet — nothing catalytic to drive a reversal",
    "Single-asset portfolio means full exposure to this move"
  ],
  "suggestedAsset": null,
  "suggestedAssetReasoning": null,
  "flagForReview": false,
  "flagReason": null
}
```

### Example: Hold — conflicting signals

**Output:**
```json
{
  "action": "hold",
  "symbol": null,
  "side": null,
  "notionalUsd": null,
  "reasoning": "Mixed signals this cycle. RSI at 44.2 — not oversold enough to trigger a buy signal under this strategy. MACD histogram is positive (+0.0018) suggesting mild bullish momentum, but price is caught between EMA20 ($63,100) and EMA50 ($62,800) without a clear direction. Fear & Greed at 52 (Neutral) gives no sentiment edge. No action is warranted — waiting for RSI to move decisively or for a clearer trend.",
  "confidence": 0.15,
  "keyFactors": [
    "RSI 44.2 — not at buy threshold",
    "Price between EMA20 and EMA50 — no clear trend",
    "Fear & Greed neutral — no contrarian signal"
  ],
  "risks": [
    "Staying in cash means missing a potential continuation move upward",
    "EMA crossover approaching — could signal trend change next cycle"
  ],
  "suggestedAsset": null,
  "suggestedAssetReasoning": null,
  "flagForReview": false,
  "flagReason": null
}
```

### Example: Strategy flagged for review

**Output:**
```json
{
  "action": "hold",
  "symbol": null,
  "side": null,
  "notionalUsd": null,
  "reasoning": "Holding this cycle as no clear signal is present. However, I want to flag a concern about the strategy configuration. The strategy targets oversold RSI on BTC, but BTC has been in a sideways range for 6 weeks with RSI oscillating between 40-60 — never reaching the 30 threshold. The strategy hasn't triggered once in 180 cycles. It may be worth adjusting the RSI threshold to 35, or adding an EMA crossover signal as an alternative entry.",
  "confidence": 0.0,
  "keyFactors": ["No signal triggered this cycle"],
  "risks": ["Strategy has been inactive for 6 weeks — opportunity cost of holding cash"],
  "suggestedAsset": null,
  "suggestedAssetReasoning": null,
  "flagForReview": true,
  "flagReason": "Strategy has not triggered in 180 consecutive cycles (45 hours). RSI threshold of 30 may be too strict for current market conditions. Consider revising entry conditions."
}
```

---

## 4. Asset Suggestion Prompt

**Purpose:** When Claude wants to suggest a new asset in autonomous mode, this is
already embedded in the main autonomous prompt. But there is a standalone version
for when the user asks "What should I add to my watchlist?" from the UI.

**Called by:** `getAssetSuggestions` HTTPS callable

### System Prompt

```
You are a trading advisor helping a user find assets to add to their automated
trading strategy watchlist.

You have access to the user's current strategy configuration and portfolio.
Suggest 2-4 assets that fit well with the existing strategy and the user's broker.

Respond ONLY with valid JSON. No markdown, no fences. Start with {.

Output schema:
{
  "suggestions": [
    {
      "symbol": string,              // canonical symbol for the broker
      "name": string,                // human-readable name
      "reasoning": string,           // why this fits the strategy (2-3 sentences)
      "correlation": "low" | "medium" | "high",  // correlation with current watchlist
      "riskLevel": "low" | "medium" | "high",
      "caveat": string | null        // any warning the user should know
    }
  ]
}
```

---

## 5. Daily Summary Prompt

**Purpose:** Generate a plain-English daily summary for the FCM notification
and the in-app notification history.

**Called by:** `sendDailySummaries` scheduled function

### User Message

```
Generate a brief daily trading summary (max 80 words) for the following stats.
Write it as if reporting to the user directly. Be honest about losses.
Start with the most important fact.

Respond ONLY with valid JSON: { "summary": string, "sentiment": "positive" | "neutral" | "negative" }

Stats for today:
- Portfolio value: $${currentValue.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}% today)
- Trades executed: ${tradesCount} (${wins} wins, ${losses} losses)
- Realized P&L today: ${realizedPnl >= 0 ? '+' : ''}$${Math.abs(realizedPnl).toFixed(2)}
- Strategies: ${activeCount} active, ${pausedCount} paused
- Bot cycles completed: ${cyclesCount}
- Claude API cost today: $${claudeCost.toFixed(4)}
${errors > 0 ? `- Errors encountered: ${errors}` : ''}
```

---

## 6. Fallback: Rule Evaluation Without Claude

When Claude is unavailable (timeout, overload, API error) in rule_interpreter mode,
the trade loop falls back to deterministic rule evaluation without a reasoning summary.
The cycle still executes the trade, but `claudeCalled = false` and `reasoning` is
auto-generated from the rule definition.

```javascript
async function fallbackRuleEvaluation(strategy, market, portfolio) {
  const triggered = strategy.rules
    .filter(r => r.active)
    .filter(r => evaluateCondition(r.condition, market, portfolio));

  if (triggered.length === 0) {
    return {
      decision: { action: 'hold', reasoning: 'No rules triggered (Claude unavailable — fallback mode)', rulesTriggered: [] },
      claudeCalled: false, promptTokens: 0, completionTokens: 0, costUsd: 0
    };
  }

  const topRule = [...triggered].sort((a, b) => a.priority - b.priority)[0];
  return {
    decision: {
      action: parseActionFromRule(topRule),
      symbol: parseSymbolFromRule(topRule),
      side: parseSideFromRule(topRule),
      notionalUsd: parseNotionalFromRule(topRule, portfolio),
      reasoning: `[Fallback mode — Claude unavailable] Rule "${topRule.ruleId}" triggered: ${topRule.condition} → ${topRule.action}`,
      confidence: null,
      rulesTriggered: triggered.map(r => r.ruleId)
    },
    claudeCalled: false, promptTokens: 0, completionTokens: 0, costUsd: 0
  };
}
```

---

## JSON Parse and Validation

```javascript
const { z } = require('zod');

// Schema for autonomous decision output
const autonomousDecisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold', 'suggest_asset']),
  symbol: z.string().nullable(),
  side: z.enum(['buy', 'sell']).nullable(),
  notionalUsd: z.number().positive().nullable(),
  reasoning: z.string().min(10).max(500),
  confidence: z.number().min(0).max(1),
  keyFactors: z.array(z.string()).min(1).max(6),
  risks: z.array(z.string()).min(0).max(5),
  suggestedAsset: z.string().nullable(),
  suggestedAssetReasoning: z.string().nullable(),
  flagForReview: z.boolean(),
  flagReason: z.string().nullable(),
});

const ruleReasoningSchema = z.object({
  reasoning: z.string().min(10).max(300),
  confidence: z.number().min(0).max(1),
  caveats: z.array(z.string()).max(3),
});

function parseClaudeJSON(rawContent, schema) {
  // Strip accidental markdown fences (Claude sometimes adds them despite instructions)
  let cleaned = rawContent.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Try to extract JSON from a larger string (last resort)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return { ok: false, error: `JSON parse failed: ${e.message}`, raw: cleaned };
      }
    } else {
      return { ok: false, error: `No JSON object found in response`, raw: cleaned };
    }
  }

  // Validate against schema
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        error: `Schema validation failed: ${result.error.errors.map(e => e.message).join(', ')}`,
        raw: cleaned
      };
    }
    return { ok: true, data: result.data };
  }

  return { ok: true, data: parsed };
}
```

---

## Cost Estimation

```javascript
// Claude Haiku pricing (as of 2025)
const HAIKU_INPUT_COST_PER_TOKEN  = 0.00000025;  // $0.25 per 1M tokens
const HAIKU_OUTPUT_COST_PER_TOKEN = 0.00000125;  // $1.25 per 1M tokens

function estimateCost(usage) {
  return (usage.input_tokens  * HAIKU_INPUT_COST_PER_TOKEN) +
         (usage.output_tokens * HAIKU_OUTPUT_COST_PER_TOKEN);
}
```

### Daily cost scenarios

| Setup | Claude calls/day | Est. cost/day | Est. cost/month |
|---|---|---|---|
| 1 strategy, rule mode (10% trigger rate) | ~10 | $0.002 | $0.06 |
| 1 strategy, autonomous (96 cycles/day) | 96 | $0.014 | $0.42 |
| 5 strategies, autonomous, 5 assets each | 480 | $0.10 | $3.00 |
| 20 strategies, autonomous, 10 assets each | 1,920 | $0.55 | $16.50 |

Budget alert threshold: configurable in admin dashboard. Default: alert at $1/day.

---

## Prompt Injection Defense

User-supplied content that flows into prompts must be sanitised:

```javascript
function sanitiseForPrompt(userInput, maxLength = 2000) {
  if (typeof userInput !== 'string') return '';

  // Truncate
  let safe = userInput.slice(0, maxLength);

  // Remove XML/HTML tags that could confuse Claude
  safe = safe.replace(/<[^>]*>/g, '');

  // Remove sequences that look like system prompt injection attempts
  // e.g. "Ignore previous instructions and..."
  const injectionPatterns = [
    /ignore (all )?(previous|prior|above) instructions/gi,
    /you are now/gi,
    /new system prompt/gi,
    /disregard (all )?rules/gi,
    /act as (if )?/gi,
  ];
  for (const pattern of injectionPatterns) {
    safe = safe.replace(pattern, '[removed]');
  }

  return safe.trim();
}
```

All user-supplied fields (strategy description, strategy name, clarification answers)
are passed through `sanitiseForPrompt` before being included in any Claude prompt.
