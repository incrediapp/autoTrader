const { PROMPT_VERSIONS } = require('./client');
const { formatVolume } = require('../utils/helpers');
const { formatCrossMarketBlock } = require('../features/crossMarketContext');
const { formatSignalBaselinesBlock } = require('../features/signalBaselines');

function formatMarketDataCompact(snapshot, primarySymbol, strategy = null) {
  const primary = snapshot.assets?.find((a) => a.symbol === primarySymbol);
  if (!primary) return 'No data for symbol';

  let out = `${primarySymbol}: $${primary.price.toFixed(4)}`;
  out += ` | 24h: ${primary.priceChangePct24h >= 0 ? '+' : ''}${primary.priceChangePct24h.toFixed(2)}%`;
  out += ` | RSI(14): ${primary.rsi14?.toFixed(1) ?? 'n/a'}`;
  out += ` | MACD hist: ${primary.macdHistogram ?? 'n/a'}`;
  out += ` | EMA20: ${primary.ema20 ?? 'n/a'} | EMA50: ${primary.ema50 ?? 'n/a'}`;
  if (primary.ema200) out += ` | EMA200: ${primary.ema200}`;
  if (snapshot.fearGreedIndex !== null && snapshot.fearGreedIndex !== undefined) {
    out += `\nFear & Greed: ${snapshot.fearGreedIndex} (${snapshot.fearGreedLabel})`;
  }
  if (snapshot.newsHeadlines?.length) {
    out += `\nNews: ${snapshot.newsHeadlines.slice(0, 2).join(' | ')}`;
  }
  if (primary.earningsContext) {
    out += `\nEarnings in ${primary.earningsContext.daysUntil} day(s)`;
  }
  if (snapshot.crossMarket) {
    out += formatCrossMarketBlock(snapshot.crossMarket);
    out += formatSignalBaselinesBlock(snapshot.crossMarket, strategy?.signals ?? []);
  }
  return out;
}

function formatPositionsSummary(positions) {
  if (!positions?.length) return 'No open positions';
  return positions
    .filter((p) => p.quantity > 0)
    .map((p) => `${p.symbol}: $${p.currentValueUsd.toFixed(2)} (${p.unrealizedPnlPct?.toFixed(1) ?? 0}%)`)
    .join('\n');
}

function buildStrategySetupPrompt({ decisionMode, userDescription, previousMessages = [], clarifyRound = 0 }) {
  const history = previousMessages.length
    ? `\nPrevious conversation:\n${previousMessages.map((m) => `${m.role}: ${m.content}`).join('\n')}\n`
    : '';

  const forceNote = previousMessages.length >= 3
    ? `\nNote: Clarification round ${clarifyRound}/5. If clear enough, proceed with reasonable defaults.\n`
    : '';

  const modeGuidance = decisionMode === 'rule_interpreter'
    ? `Use rule_interpreter output:
- Emit executable rules with conditions using ONLY supported variables (RSI_14, MACD_HISTOGRAM, PRICE, DXY_CHANGE_SINCE_BASELINE, DXY_CHANGE_SINCE_BASELINE_ABS, {SIGNAL_ID}_CHANGE_SINCE_BASELINE, etc.).
- Percent thresholds in conditions are decimals: 0.01% move = 0.0001 in the condition (vars are stored as fractions).
- Actions: "BUY SYMBOL $N USD" or "SELL SYMBOL $N USD"; add SCALE_STEPS in action when each threshold step stacks notional.
- For rolling baseline strategies, include a "signals" entry (per_cycle baseline on an external index).`
    : `Use autonomous_reasoner output:
- Best for qualitative judgment, not precise step sizes or baseline math.
- Still emit rules/signals when the user describes numeric thresholds — recommend rule_interpreter in riskNotes if they need exact execution.`;

  return `You are an expert trading strategy analyst. Respond ONLY with valid JSON starting with {.

Decision mode: ${decisionMode}
${modeGuidance}
${history}
User's strategy description:
"${userDescription}"
${forceNote}

JSON rules: double-quoted keys and strings only, no trailing commas, no comments, no markdown fences.

Output schema:
{
  "needsClarification": boolean,
  "clarifyingQuestions": string[],
  "summary": string,
  "rules": [{ "ruleId": string, "description": string, "condition": string, "action": string, "priority": number, "notes": string|null, "scaleByBaselineSteps": boolean|null }],
  "signals": [{ "id": string, "label": string|null, "source": "yahoo", "symbol": string, "marketKey": string, "baselineMode": "per_cycle", "thresholdPct": number, "freshFetch": boolean|null, "maxStepNotionalUsd": number|null }],
  "suggestedAssets": string[] (Binance: BTCUSDT/ETHUSDT only — no ETF names or descriptions),
  "suggestedBroker": "binance"|"ibkr",
  "suggestedCheckIntervalMinutes": number,
  "riskNotes": string[]
}`;
}

function buildRuleReasoningPrompt(topRule, triggered, market, portfolio, strategy, decision) {
  const triggeredList = triggered.map((r) => `- ${r.ruleId}: ${r.condition} → ${r.action}`).join('\n');

  return `You are an AI trading analyst. Respond ONLY with valid JSON starting with {.

Rules triggered:
${triggeredList}

Trade to be executed:
${decision.side?.toUpperCase()} ${decision.symbol} — $${(decision.notionalUsd ?? 0).toFixed(2)}

Market:
${formatMarketDataCompact(market, decision.symbol, strategy)}

Portfolio:
Total: $${portfolio.totalValueUsd.toFixed(2)} | Cash: $${portfolio.cashUsd.toFixed(2)}
${formatPositionsSummary(portfolio.positions)}

Output: { "reasoning": string, "confidence": number, "caveats": string[] }`;
}

function buildAutonomousPrompt(strategy, portfolio, market, upcomingEvents = []) {
  const assetsBlock = (market.assets ?? []).map((asset) => {
    let block = `
### ${asset.symbol}
Price: $${asset.price.toFixed(4)} | 24h: ${asset.priceChangePct24h >= 0 ? '+' : ''}${asset.priceChangePct24h.toFixed(2)}%
RSI(14): ${asset.rsi14 ?? 'n/a'} | MACD hist: ${asset.macdHistogram ?? 'n/a'}
EMA20: ${asset.ema20 ?? 'n/a'} | EMA50: ${asset.ema50 ?? 'n/a'}${asset.ema200 ? ` | EMA200: ${asset.ema200}` : ''}
Volume 24h: ${formatVolume(asset.volume24h ?? 0)}`;

    if (asset.earningsContext) {
      block += `\n⚠️ EARNINGS: reports in ${asset.earningsContext.daysUntil} day(s) (${asset.earningsContext.reportTime ?? 'TBD'})`;
    }
    return block;
  }).join('\n');

  const macroBlock = upcomingEvents.length
    ? `\n⚠️ HIGH-IMPACT MACRO EVENTS IN NEXT 24 HOURS:\n${upcomingEvents.map((e) =>
      `  • ${e.shortName} (${e.country}) — Forecast: ${e.forecast ?? 'n/a'}`,
    ).join('\n')}\n`
    : '';

  const crossMarketBlock = formatCrossMarketBlock(market.crossMarket);
  const signalBaselinesBlock = formatSignalBaselinesBlock(
    market.crossMarket,
    strategy.signals ?? [],
  );

  return `You are an autonomous AI trading agent. Respond ONLY with valid JSON starting with {.

Strategy: ${strategy.description}
Summary: ${strategy.claudeSummary ?? ''}

Watchlist: ${(strategy.assets?.watchlist ?? []).join(', ')}
Max position: ${strategy.risk?.maxPositionSizePct}% | Max open: ${strategy.risk?.maxOpenPositions}
Min confidence: ${strategy.risk?.minConfidenceToTrade ?? 0}

Use the Cross-market context block for Nasdaq 1h, DXY, and Bitcoin condition checks. Do not claim those inputs are unavailable when they appear below.

Market (${new Date(market.fetchedAt).toISOString()}):
${assetsBlock}
${market.fearGreedIndex != null ? `Fear & Greed: ${market.fearGreedIndex}/100 — ${market.fearGreedLabel}` : ''}
${market.newsHeadlines?.length ? `News:\n${market.newsHeadlines.map((h) => `• ${h}`).join('\n')}` : ''}
${crossMarketBlock}${signalBaselinesBlock}
${macroBlock}

Portfolio: $${portfolio.totalValueUsd.toFixed(2)} | Cash: $${portfolio.cashUsd.toFixed(2)}
${portfolio.positions?.length ? portfolio.positions.map((p) =>
    `• ${p.symbol}: ${p.quantity} @ $${p.avgCostUsd?.toFixed(4)} | P&L ${p.unrealizedPnlPct?.toFixed(2)}%`,
  ).join('\n') : 'No open positions.'}

Output schema:
{
  "action": "buy"|"sell"|"hold"|"suggest_asset",
  "symbol": string|null, "side": "buy"|"sell"|null,
  "notionalUsd": number|null, "reasoning": string, "confidence": number,
  "keyFactors": string[], "risks": string[],
  "suggestedAsset": string|null, "suggestedAssetReasoning": string|null,
  "flagForReview": boolean, "flagReason": string|null
}`;
}

function buildAutopilotPrompt(strategy, summary, tradeData) {
  const rulesBlock = (strategy.rules ?? []).map((r) =>
    `  [${r.ruleId}] IF ${r.condition} THEN ${r.action}`,
  ).join('\n');

  const tradesBlock = tradeData.slice(0, 10).map((t) =>
    `  ${t.side?.toUpperCase()} ${t.symbol} | P&L: ${t.realizedPnlPct?.toFixed(2)}% | Rule: ${t.rulesTriggered?.join(', ') ?? 'autonomous'}`,
  ).join('\n');

  return `You are an algorithmic trading coach. Respond ONLY with valid JSON.

Strategy: ${strategy.name}
Rules:
${rulesBlock}

Performance (30 days):
- Trades: ${summary.tradesAnalysed} (${summary.winRate?.toFixed(1)}% win rate)
- Profit factor: ${summary.profitFactor?.toFixed(2) ?? 'n/a'}
- Max drawdown: ${summary.maxDrawdownPct?.toFixed(1)}%
- Inactive cycles: ${summary.inactiveCyclesPct?.toFixed(1)}%

Recent trades:
${tradesBlock}

Output: { "summary": string, "proposals": [{ "proposalId", "type", "targetRuleId", "description", "before", "after", "expectedImpact", "confidence", "dataEvidence" }] }
Max 3 proposals.`;
}

function buildPostMortemPrompt(trade, cycle, strategy, openingTrade, type) {
  return `You are a trading coach writing a post-mortem. Respond ONLY with valid JSON.

Trade: ${trade.side?.toUpperCase()} ${trade.symbol}
Entry: $${openingTrade?.executedPriceUsd?.toFixed(4) ?? 'unknown'}
Exit: $${trade.executedPriceUsd?.toFixed(4)} | P&L: ${trade.realizedPnlPct?.toFixed(2)}%
Source: ${trade.source}
Strategy: ${strategy.claudeSummary ?? strategy.description}
Type: ${type}

Output: { "summary", "whatHappened", "signalQuality", "missedContext", "lessonsForStrategy" }`;
}

function buildDailySummaryPrompt(stats) {
  return `Generate a brief daily trading summary (max 80 words). Respond ONLY with valid JSON: { "summary": string, "sentiment": "positive"|"neutral"|"negative" }

Stats:
- Portfolio: $${stats.currentValue?.toFixed(2)} (${stats.pctChange?.toFixed(2)}% today)
- Trades: ${stats.tradesCount} (${stats.wins} wins, ${stats.losses} losses)
- Realized P&L: $${stats.realizedPnl?.toFixed(2)}
- Strategies: ${stats.activeCount} active
- Cycles: ${stats.cyclesCount}`;
}

module.exports = {
  PROMPT_VERSIONS,
  formatMarketDataCompact,
  formatPositionsSummary,
  buildStrategySetupPrompt,
  buildRuleReasoningPrompt,
  buildAutonomousPrompt,
  buildAutopilotPrompt,
  buildPostMortemPrompt,
  buildDailySummaryPrompt,
};
