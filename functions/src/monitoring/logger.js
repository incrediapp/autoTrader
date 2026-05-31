const { logger } = require('firebase-functions');

function createLogContext(functionName, userId = null, strategyId = null) {
  return {
    service: 'ai-auto-trader',
    function: functionName,
    userId: userId ?? 'system',
    strategyId: strategyId ?? 'none',
    env: process.env.FUNCTIONS_EMULATOR ? 'local' : 'production',
  };
}

function logInfo(ctx, message, extra = {}) {
  logger.info(message, { ...ctx, ...extra });
}

function logWarn(ctx, message, extra = {}) {
  logger.warn(message, { severity: 'WARNING', ...ctx, ...extra });
}

function logErrorLog(ctx, message, err, extra = {}) {
  logger.error(message, {
    severity: 'ERROR',
    ...ctx,
    errorMessage: err?.message,
    errorCode: err?.code ?? null,
    stack: err?.stack?.split('\n').slice(0, 5).join(' | ') ?? null,
    ...extra,
  });
}

function logCycleSummary(ctx, {
  runId, totalStrategies, eligibleStrategies, tradeCount, errorCount, durationMs,
}) {
  logger.info('Trade loop run complete', {
    ...ctx,
    event: 'TRADE_LOOP_COMPLETE',
    runId,
    totalStrategies,
    eligibleStrategies,
    tradeCount,
    errorCount,
    errorRatePct: eligibleStrategies > 0
      ? ((errorCount / eligibleStrategies) * 100).toFixed(1)
      : 0,
    durationMs,
    avgStrategyMs: eligibleStrategies > 0
      ? Math.round(durationMs / eligibleStrategies)
      : 0,
  });
}

function logBrokerCall(ctx, {
  broker, endpoint, method, success, durationMs, errorCode = null,
}) {
  logger.info('Broker API call', {
    ...ctx,
    event: 'BROKER_API_CALL',
    broker,
    endpoint,
    method,
    success,
    durationMs,
    errorCode,
  });
}

function logClaudeCall(ctx, {
  promptVersion, promptTokens, completionTokens, costUsd, latencyMs, parseSuccess, mode,
}) {
  logger.info('Claude API call', {
    ...ctx,
    event: 'CLAUDE_API_CALL',
    promptVersion,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: typeof costUsd === 'number' ? costUsd.toFixed(6) : costUsd,
    latencyMs,
    parseSuccess,
    mode,
  });
}

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
      event: 'FUNCTION_PERFORMANCE',
      function: this.functionName,
      totalMs,
      phases: this.phases,
      slowPhases: Object.entries(this.phases)
        .filter(([, ms]) => ms > 2000)
        .map(([name, ms]) => `${name}:${ms}ms`),
    });

    return { totalMs, phases: this.phases };
  }
}

module.exports = {
  createLogContext,
  logInfo,
  logWarn,
  logErrorLog,
  logCycleSummary,
  logBrokerCall,
  logClaudeCall,
  PerformanceTimer,
};
