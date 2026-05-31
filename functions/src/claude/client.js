const { getSecret } = require('../utils/secrets');
const { sleep } = require('../utils/helpers');
const { logClaudeCall } = require('../monitoring/logger');
const { incrementSystemMetric } = require('../monitoring/metrics');

const CLAUDE_CONFIG = {
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  temperature: 0,
  top_p: 1,
};

const PROMPT_VERSIONS = {
  STRATEGY_SETUP: 'v2.1',
  STRATEGY_CLARIFY: 'v2.0',
  RULE_REASONING: 'v2.1',
  AUTONOMOUS_DECISION: 'v2.2',
  ASSET_SUGGESTION: 'v1.3',
  DAILY_SUMMARY: 'v1.1',
  AUTOPILOT: 'v1.0',
  POST_MORTEM: 'v1.0',
};

async function callClaude(prompt, ctx = {}, maxRetries = 2) {
  let apiKey;
  try {
    apiKey = await getSecret('anthropic_api_key');
  } catch {
    if (process.env.FUNCTIONS_EMULATOR) {
      throw new Error('Claude API key not configured for local dev');
    }
    throw new Error('Claude API key unavailable');
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const startMs = Date.now();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_CONFIG.model,
          max_tokens: ctx.maxTokens ?? CLAUDE_CONFIG.max_tokens,
          temperature: CLAUDE_CONFIG.temperature,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 529 || response.status === 503) {
        if (attempt < maxRetries) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        throw new Error(`Claude API overloaded after ${maxRetries + 1} attempts`);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Claude API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      const usage = data.usage ?? { input_tokens: 0, output_tokens: 0 };
      const latencyMs = Date.now() - startMs;
      const costUsd = (usage.input_tokens * 0.00000025) + (usage.output_tokens * 0.00000125);

      logClaudeCall(ctx, {
        promptVersion: ctx.promptVersion ?? 'unknown',
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        costUsd,
        latencyMs,
        parseSuccess: true,
        mode: ctx.mode ?? 'unknown',
      });

      await incrementSystemMetric('claudeCallsToday', 1);
      await incrementSystemMetric('claudeCostUsdToday', costUsd);

      return {
        content: data.content[0].text,
        usage,
        latencyMs,
        costUsd,
        model: CLAUDE_CONFIG.model,
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error('Claude API timeout after 30 seconds');
      }
      if (attempt === maxRetries) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }

  throw new Error('Claude API call failed');
}

module.exports = {
  callClaude,
  CLAUDE_CONFIG,
  PROMPT_VERSIONS,
};
