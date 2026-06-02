const { getDb, FieldValue } = require('../utils/db');
const { generateTradeId } = require('../utils/helpers');
const { getClaudeDecision } = require('../claude/decision');
const { validateDecision } = require('../tradeLoop/validation');
const { evaluateCondition, parseActionFromRule, parseSymbolFromRule, parseSideFromRule, parseNotionalFromRule } = require('../strategy/rules');

function mergeShadowStrategy(parentStrategy, shadowConfig) {
  const overrides = shadowConfig.overrides ?? {};
  return {
    ...parentStrategy,
    decisionMode: overrides.decisionModeOverride ?? parentStrategy.decisionMode,
    rules: overrides.rules ?? parentStrategy.rules,
    risk: {
      ...parentStrategy.risk,
      ...(overrides.riskOverrides ?? {}),
    },
  };
}

async function runShadowCycles(parentStrategy, portfolioSnapshot, marketSnapshot, parentCycleId, shadowConfigs) {
  for (const shadow of shadowConfigs) {
    try {
      const shadowStrategy = mergeShadowStrategy(parentStrategy, shadow);
      let decision;

      if (shadowStrategy.decisionMode === 'rule_interpreter') {
        const triggered = (shadowStrategy.rules ?? [])
          .filter((r) => r.active)
          .filter((r) => evaluateCondition(r.condition, marketSnapshot, portfolioSnapshot, shadowStrategy));

        if (triggered.length === 0) {
          decision = { action: 'hold', reasoning: 'No shadow rules triggered' };
        } else {
          const topRule = [...triggered].sort((a, b) => a.priority - b.priority)[0];
          decision = {
            action: parseActionFromRule(topRule),
            symbol: parseSymbolFromRule(topRule),
            side: parseSideFromRule(topRule),
            notionalUsd: parseNotionalFromRule(topRule, portfolioSnapshot),
            reasoning: `Shadow rule: ${topRule.ruleId}`,
          };
        }
      } else {
        const result = await getClaudeDecision(shadowStrategy, portfolioSnapshot, marketSnapshot);
        decision = result.decision;
      }

      const parentCycle = await getDb()
        .doc(`users/${parentStrategy.userId}/strategies/${parentStrategy.strategyId}/cycles/${parentCycleId}`)
        .get();
      const parentDecision = parentCycle.data()?.decision?.action ?? 'hold';

      const { decision: validated } = validateDecision(decision, shadowStrategy, portfolioSnapshot, marketSnapshot);

      if (validated.action === 'buy' || validated.action === 'sell') {
        const tradeId = generateTradeId();
        const asset = marketSnapshot.assets.find((a) => a.symbol === validated.symbol);
        const price = asset?.price ?? 0;
        const qty = price > 0 ? validated.notionalUsd / price : 0;

        await getDb()
          .doc(`users/${parentStrategy.userId}/strategies/${parentStrategy.strategyId}/shadowTrades/${tradeId}`)
          .set({
            tradeId,
            shadowId: shadow.shadowId,
            parentCycleId,
            parentDecision,
            userId: parentStrategy.userId,
            strategyId: parentStrategy.strategyId,
            symbol: validated.symbol,
            side: validated.side,
            mode: 'paper',
            source: 'shadow',
            executedQuantity: qty,
            executedPriceUsd: price,
            executedNotionalUsd: validated.notionalUsd,
            claudeReasoning: validated.reasoning,
            requestedAt: FieldValue.serverTimestamp(),
            executedAt: FieldValue.serverTimestamp(),
            expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          });

        await getDb()
          .doc(`users/${parentStrategy.userId}/strategies/${parentStrategy.strategyId}/shadowConfigs/${shadow.shadowId}`)
          .update({
            'stats.totalShadowTrades': FieldValue.increment(1),
            'stats.lastUpdatedAt': FieldValue.serverTimestamp(),
          });
      }
    } catch {
      // shadow mode must not affect main loop
    }
  }
}

module.exports = {
  runShadowCycles,
  mergeShadowStrategy,
};
