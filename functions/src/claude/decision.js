const { evaluateCondition, parseActionFromRule, parseSymbolFromRule, parseSideFromRule, parseNotionalFromRule } = require('../strategy/rules');
const { callClaude, PROMPT_VERSIONS } = require('./client');
const {
  buildRuleReasoningPrompt,
  buildAutonomousPrompt,
} = require('./prompts');
const {
  parseClaudeJSON,
  estimateCost,
  autonomousDecisionSchema,
  ruleReasoningSchema,
} = require('./parser');
const { createLogContext, logWarn } = require('../monitoring/logger');
const { scaleNotionalByBaselineSteps } = require('../features/signalBaselines');

async function getClaudeDecision(strategy, portfolio, market, upcomingEvents = []) {
  if (strategy.decisionMode === 'rule_interpreter') {
    return getClaudeDecisionRuleInterpreter(strategy, portfolio, market);
  }
  return getClaudeDecisionAutonomous(strategy, portfolio, market, upcomingEvents);
}

async function getClaudeDecisionRuleInterpreter(strategy, portfolio, market) {
  const activeRules = (strategy.rules ?? []).filter((r) => r.active);
  const triggered = activeRules.filter((r) => evaluateCondition(r.condition, market, portfolio, strategy));

  if (triggered.length === 0) {
    return {
      decision: {
        action: 'hold',
        reasoning: `No rules triggered. Monitoring ${activeRules.length} rules.`,
        rulesTriggered: [],
        confidence: null,
      },
      claudeCalled: false,
      claudeMode: 'rule_interpreter',
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    };
  }

  const topRule = [...triggered].sort((a, b) => a.priority - b.priority)[0];
  const baseNotional = parseNotionalFromRule(topRule, portfolio);
  const scaledNotional = scaleNotionalByBaselineSteps(topRule, strategy, market, baseNotional);

  if (scaledNotional <= 0) {
    return {
      decision: {
        action: 'hold',
        reasoning: `Rule ${topRule.ruleId} matched but notional is $0 after baseline step scaling.`,
        rulesTriggered: triggered.map((r) => r.ruleId),
        confidence: null,
      },
      claudeCalled: false,
      claudeMode: 'rule_interpreter',
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    };
  }

  const decision = {
    action: parseActionFromRule(topRule),
    symbol: parseSymbolFromRule(topRule),
    side: parseSideFromRule(topRule),
    notionalUsd: scaledNotional,
    rulesTriggered: triggered.map((r) => r.ruleId),
  };

  const ctx = createLogContext('claude', strategy.userId, strategy.strategyId);
  ctx.promptVersion = PROMPT_VERSIONS.RULE_REASONING;
  ctx.mode = 'rule_interpreter';

  try {
    const prompt = buildRuleReasoningPrompt(topRule, triggered, market, portfolio, strategy, decision);
    const { content, usage, latencyMs, costUsd, model } = await callClaude(prompt, ctx);
    const parsed = parseClaudeJSON(content, ruleReasoningSchema);

    if (!parsed.ok) {
      return {
        decision: {
          ...decision,
          reasoning: `Rule triggered: ${topRule.condition} → ${topRule.action}`,
          confidence: null,
        },
        claudeCalled: true,
        claudeMode: 'rule_interpreter',
        claudeModel: model,
        claudeParseSuccess: false,
        claudeParseError: parsed.error,
        claudeRawResponse: content,
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        costUsd,
        latencyMs,
      };
    }

    return {
      decision: {
        ...decision,
        reasoning: parsed.data.reasoning,
        confidence: parsed.data.confidence,
      },
      claudeCalled: true,
      claudeMode: 'rule_interpreter',
      claudeModel: model,
      claudeParseSuccess: true,
      claudeRawResponse: content,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      costUsd,
      latencyMs,
      rulesEvaluated: activeRules.length,
      rulesTriggered: triggered.map((r) => r.ruleId),
    };
  } catch {
    return fallbackRuleEvaluation(strategy, market, portfolio);
  }
}

async function getClaudeDecisionAutonomous(strategy, portfolio, market, upcomingEvents = []) {
  const ctx = createLogContext('claude', strategy.userId, strategy.strategyId);
  ctx.promptVersion = PROMPT_VERSIONS.AUTONOMOUS_DECISION;
  ctx.mode = 'autonomous_reasoner';

  const prompt = buildAutonomousPrompt(strategy, portfolio, market, upcomingEvents);
  const { content, usage, latencyMs, costUsd, model } = await callClaude(prompt, {
    ...ctx,
    maxTokens: 4096,
  });
  const parsed = parseClaudeJSON(content, autonomousDecisionSchema);

  if (!parsed.ok) {
    logWarn(ctx, 'Autonomous Claude response parse failed', {
      parseError: parsed.error,
      rawPreview: content?.slice(0, 400) ?? '',
      rawTail: content?.slice(-400) ?? '',
    });
    return {
      decision: {
        action: 'hold',
        symbol: null,
        side: null,
        reasoning: 'Claude response could not be parsed; holding this cycle.',
        confidence: null,
      },
      claudeCalled: true,
      claudeMode: 'autonomous_reasoner',
      claudeModel: model,
      claudeParseSuccess: false,
      claudeParseError: parsed.error,
      claudeRawResponse: content,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      costUsd,
      latencyMs,
    };
  }

  const d = parsed.data;
  if (d.action === 'buy' || d.action === 'sell') {
    d.side = d.side ?? d.action;
    if (!d.symbol) throw new Error('Claude response missing symbol for trade action');
  }

  return {
    decision: d,
    claudeCalled: true,
    claudeMode: 'autonomous_reasoner',
    claudeModel: model,
    claudeParseSuccess: true,
    claudeRawResponse: content,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    costUsd,
    latencyMs,
  };
}

async function fallbackRuleEvaluation(strategy, market, portfolio) {
  const triggered = (strategy.rules ?? [])
    .filter((r) => r.active)
    .filter((r) => evaluateCondition(r.condition, market, portfolio, strategy));

  if (triggered.length === 0) {
    return {
      decision: {
        action: 'hold',
        reasoning: 'No rules triggered (Claude unavailable — fallback mode)',
        rulesTriggered: [],
      },
      claudeCalled: false,
      claudeMode: 'rule_interpreter',
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    };
  }

  const topRule = [...triggered].sort((a, b) => a.priority - b.priority)[0];
  return {
    decision: {
      action: parseActionFromRule(topRule),
      symbol: parseSymbolFromRule(topRule),
      side: parseSideFromRule(topRule),
      notionalUsd: parseNotionalFromRule(topRule, portfolio),
      reasoning: `[Fallback] Rule "${topRule.ruleId}" triggered: ${topRule.condition} → ${topRule.action}`,
      confidence: null,
      rulesTriggered: triggered.map((r) => r.ruleId),
    },
    claudeCalled: false,
    claudeMode: 'rule_interpreter',
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };
}

async function previewDecision(strategy, portfolio, market, upcomingEvents = []) {
  try {
    const result = await getClaudeDecision(strategy, portfolio, market, upcomingEvents);
    return result.decision;
  } catch {
    return { action: 'hold', reasoning: 'Preview failed', confidence: 0 };
  }
}

module.exports = {
  getClaudeDecision,
  fallbackRuleEvaluation,
  previewDecision,
  estimateCost,
};
