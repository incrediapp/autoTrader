const { z } = require('zod');

function normalizeConfidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return value > 1 ? value / 100 : value;
}

function truncateText(value, maxLen) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

const autonomousDecisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold', 'suggest_asset']),
  symbol: z.preprocess((val) => (val === '' ? null : val), z.string().nullable()),
  side: z.preprocess((val) => (val === '' ? null : val), z.enum(['buy', 'sell']).nullable()),
  notionalUsd: z.preprocess(
    (val) => (val === 0 ? null : val),
    z.number().positive().nullable().optional(),
  ),
  reasoning: z.preprocess(
    (val) => truncateText(val, 2000),
    z.string().min(1).max(2000),
  ),
  confidence: z.preprocess(normalizeConfidence, z.number().min(0).max(1).nullable().optional()),
  keyFactors: z.array(z.string()).max(12).optional()
    .transform((items) => items?.slice(0, 6)),
  risks: z.array(z.string()).max(10).optional()
    .transform((items) => items?.slice(0, 5)),
  suggestedAsset: z.string().nullable().optional(),
  suggestedAssetReasoning: z.string().nullable().optional(),
  flagForReview: z.boolean().optional(),
  flagReason: z.string().nullable().optional(),
});

const ruleReasoningSchema = z.object({
  reasoning: z.string().min(10).max(300),
  confidence: z.number().min(0).max(1),
  caveats: z.array(z.string()).max(3),
});

const strategySetupSchema = z.object({
  needsClarification: z.boolean(),
  clarifyingQuestions: z.array(z.string()).optional(),
  summary: z.string().optional(),
  rules: z.array(z.object({
    ruleId: z.string(),
    description: z.string().optional(),
    condition: z.string(),
    action: z.string(),
    priority: z.number(),
    notes: z.string().nullable().optional(),
  })).optional(),
  suggestedAssets: z.array(z.string()).optional(),
  suggestedBroker: z.enum(['binance', 'ibkr']).optional(),
  suggestedCheckIntervalMinutes: z.number().optional(),
  riskNotes: z.array(z.string()).optional(),
});

const postMortemSchema = z.object({
  summary: z.string(),
  whatHappened: z.string(),
  signalQuality: z.string(),
  missedContext: z.array(z.string()),
  lessonsForStrategy: z.array(z.string()),
});

const autopilotReportSchema = z.object({
  summary: z.string().optional(),
  proposals: z.array(z.object({
    proposalId: z.string(),
    type: z.string(),
    targetRuleId: z.string().nullable().optional(),
    description: z.string(),
    before: z.string().nullable().optional(),
    after: z.string().nullable().optional(),
    expectedImpact: z.string().optional(),
    confidence: z.number().optional(),
    dataEvidence: z.string().optional(),
  })).optional(),
});

function repairJsonText(text) {
  let repaired = text.trim();
  repaired = repaired.replace(/[\u201C\u201D]/g, '"');
  repaired = repaired.replace(/[\u2018\u2019]/g, "'");
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/^\s*\/\/.*$/gm, '');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  return repaired;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function parseClaudeJSON(rawContent, schema) {
  let cleaned = rawContent.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/i, '');

  const candidates = [
    cleaned,
    repairJsonText(cleaned),
  ];

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    candidates.push(jsonMatch[0], repairJsonText(jsonMatch[0]));
  }

  let parsed;
  let lastError = null;
  for (const candidate of candidates) {
    const attempt = tryParseJson(candidate);
    if (attempt.ok) {
      parsed = attempt.value;
      break;
    }
    lastError = attempt.error;
  }

  if (!parsed) {
    return {
      ok: false,
      error: `JSON parse failed: ${lastError?.message ?? 'unknown error'}`,
      raw: cleaned,
    };
  }

  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        error: `Schema validation failed: ${result.error.errors.map((e) => e.message).join(', ')}`,
        raw: cleaned,
      };
    }
    return { ok: true, data: result.data };
  }

  return { ok: true, data: parsed };
}

const HAIKU_INPUT_COST_PER_TOKEN = 0.00000025;
const HAIKU_OUTPUT_COST_PER_TOKEN = 0.00000125;

function estimateCost(usage) {
  return (usage.input_tokens * HAIKU_INPUT_COST_PER_TOKEN)
    + (usage.output_tokens * HAIKU_OUTPUT_COST_PER_TOKEN);
}

module.exports = {
  parseClaudeJSON,
  estimateCost,
  autonomousDecisionSchema,
  ruleReasoningSchema,
  strategySetupSchema,
  postMortemSchema,
  autopilotReportSchema,
};
