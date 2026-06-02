const { z } = require('zod');
const { HttpsError } = require('firebase-functions/v2/https');
const { nanoid } = require('nanoid');
const { getDb, FieldValue } = require('../utils/db');
const { sanitiseForPrompt } = require('../utils/sanitise');
const { normalizeWatchlist } = require('../brokers/symbolNormalize');
const { enforceRateLimit } = require('../utils/rateLimit');
const { callClaude, PROMPT_VERSIONS } = require('../claude/client');
const { buildStrategySetupPrompt } = require('../claude/prompts');
const { parseClaudeJSON, strategySetupSchema } = require('../claude/parser');
const { createLogContext, logInfo, logErrorLog } = require('../monitoring/logger');

const inputSchema = z.object({
  strategyName: z.string().min(1).max(50),
  description: z.string().min(10).max(2000),
  decisionMode: z.enum(['rule_interpreter', 'autonomous_reasoner']),
  clarificationHistory: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(2000),
  })).max(10).optional(),
});

async function strategySetupHandler(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'strategy_setup');

  const parsed = inputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.errors[0].message);
  }

  const { description, decisionMode, clarificationHistory = [] } = parsed.data;
  const sanitisedDescription = sanitiseForPrompt(description);

  const ctx = createLogContext('strategySetup', userId);
  const prompt = buildStrategySetupPrompt({
    decisionMode,
    userDescription: sanitisedDescription,
    previousMessages: clarificationHistory,
    clarifyRound: clarificationHistory.filter((m) => m.role === 'user').length,
  });

  const { content, costUsd } = await callClaude(prompt, {
    ...ctx,
    promptVersion: PROMPT_VERSIONS.STRATEGY_SETUP,
    mode: 'strategy_setup',
    maxTokens: 4096,
  });

  const result = parseClaudeJSON(content, strategySetupSchema);
  if (!result.ok) {
    logErrorLog(ctx, 'Strategy setup JSON parse failed', new Error(result.error), {
      rawLength: content?.length ?? 0,
      rawPreview: content?.slice(0, 500) ?? '',
      rawTail: content?.slice(-500) ?? '',
    });
    throw new HttpsError('internal', `Failed to parse Claude response: ${result.error}`);
  }

  logInfo(ctx, 'Strategy setup completed', { needsClarification: result.data.needsClarification });

  return {
    ...result.data,
    suggestedAssets: result.data.suggestedAssets
      ? normalizeWatchlist(result.data.suggestedAssets, result.data.suggestedBroker ?? 'binance')
      : result.data.suggestedAssets,
    claudeCostUsd: costUsd,
    promptVersion: PROMPT_VERSIONS.STRATEGY_SETUP,
  };
}

async function strategyReinterpretHandler(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'strategy_reinterpret');

  const { strategyId, newDescription } = request.data ?? {};
  if (!strategyId || !newDescription) {
    throw new HttpsError('invalid-argument', 'strategyId and newDescription required');
  }

  const stratRef = getDb().doc(`users/${userId}/strategies/${strategyId}`);
  const strat = await stratRef.get();
  if (!strat.exists) throw new HttpsError('not-found', 'Strategy not found');

  const strategy = strat.data();
  const sanitised = sanitiseForPrompt(newDescription);

  const prompt = buildStrategySetupPrompt({
    decisionMode: strategy.decisionMode,
    userDescription: sanitised,
    previousMessages: [],
  });

  const { content, costUsd } = await callClaude(prompt, {
    promptVersion: PROMPT_VERSIONS.STRATEGY_SETUP,
    mode: 'strategy_reinterpret',
  });

  const result = parseClaudeJSON(content, strategySetupSchema);
  if (!result.ok || result.data.needsClarification) {
    throw new HttpsError('failed-precondition', 'Strategy needs clarification');
  }

  await stratRef.update({
    description: sanitised,
    claudeSummary: result.data.summary,
    interpretedAt: FieldValue.serverTimestamp(),
    interpretedModelVersion: 'claude-haiku-4-5',
    rules: result.data.rules ?? strategy.rules,
    signals: result.data.signals ?? strategy.signals ?? [],
    updatedAt: FieldValue.serverTimestamp(),
    descriptionHistory: FieldValue.arrayUnion({
      text: sanitised,
      updatedAt: new Date(),
      claudeSummary: result.data.summary,
    }),
  });

  return { summary: result.data.summary, rules: result.data.rules, claudeCostUsd: costUsd };
}

async function createStrategyHandler(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'create_strategy');

  const schema = z.object({
    name: z.string().min(1).max(50),
    description: z.string().min(10).max(2000),
    decisionMode: z.enum(['rule_interpreter', 'autonomous_reasoner']),
    claudeSummary: z.string(),
    rules: z.array(z.any()).optional(),
    signals: z.array(z.object({
      id: z.string(),
      label: z.string().nullable().optional(),
      source: z.enum(['yahoo']),
      symbol: z.string(),
      marketKey: z.string(),
      baselineMode: z.enum(['per_cycle']),
      thresholdPct: z.number().positive(),
      freshFetch: z.boolean().optional(),
      maxStepNotionalUsd: z.number().positive().optional(),
    })).optional(),
    assets: z.object({
      broker: z.enum(['binance', 'ibkr']),
      watchlist: z.array(z.string()).min(1).max(20),
    }),
    risk: z.object({
      maxLossPerTradePct: z.number().default(2),
      maxDrawdownPct: z.number().default(15),
      maxPositionSizePct: z.number().default(20),
      maxOpenPositions: z.number().default(5),
      minConfidenceToTrade: z.number().default(0),
      stopLossPerTradePct: z.number().nullable().optional(),
      takeProfitPerTradePct: z.number().nullable().optional(),
      earningsBlackoutDays: z.number().default(0),
      macroBlackoutHoursBefore: z.number().default(0),
      macroBlackoutHoursAfter: z.number().default(0),
    }).optional(),
    schedule: z.object({
      checkIntervalMinutes: z.number().default(15),
    }).optional(),
  });

  const parsed = schema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.errors[0].message);
  }

  const data = parsed.data;
  const strategyId = nanoid(12);
  const now = FieldValue.serverTimestamp();
  const watchlist = normalizeWatchlist(data.assets.watchlist, data.assets.broker);

  const strategyDoc = {
    strategyId,
    userId,
    name: data.name,
    description: sanitiseForPrompt(data.description),
    descriptionHistory: [{
      text: data.description,
      updatedAt: new Date(),
      claudeSummary: data.claudeSummary,
    }],
    claudeSummary: data.claudeSummary,
    interpretedAt: now,
    interpretedModelVersion: 'claude-haiku-4-5',
    decisionMode: data.decisionMode,
    decisionModeHistory: [{ mode: data.decisionMode, changedAt: new Date() }],
    rules: (data.rules ?? []).map((r) => ({
      ...r,
      active: r.active !== false,
      createdAt: new Date(),
      triggerCount: 0,
      lastTriggeredAt: null,
    })),
    signals: data.signals ?? [],
    assets: {
      broker: data.assets.broker,
      watchlist,
      claudeSuggested: data.assets.watchlist,
    },
    risk: {
      maxLossPerTradePct: 2,
      maxDrawdownPct: 15,
      maxPositionSizePct: 20,
      maxOpenPositions: 5,
      minConfidenceToTrade: 0,
      stopLossPerTradePct: null,
      takeProfitPerTradePct: null,
      earningsBlackoutDays: 0,
      macroBlackoutHoursBefore: 0,
      macroBlackoutHoursAfter: 0,
      ...data.risk,
    },
    mode: 'paper',
    modeHistory: [{ mode: 'paper', changedAt: new Date(), changedByUserId: userId }],
    liveEnabledAt: null,
    paperStartedAt: now,
    status: 'active',
    statusHistory: [{ status: 'active', changedAt: new Date(), reason: null }],
    pausedAt: null,
    autoPausedAt: null,
    autoPausedReason: null,
    archivedAt: null,
    brokerHealth: {
      lastSuccessfulCycleAt: null,
      consecutiveFailures: 0,
      brokerUnreachable: false,
      brokerUnreachableAt: null,
    },
    pendingOrderIds: [],
    schedule: {
      checkIntervalMinutes: data.schedule?.checkIntervalMinutes ?? 15,
      activeHours: { enabled: false, start: '00:00', end: '23:59', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' },
      priceThresholds: [],
    },
    notifications: { useDefaults: true },
    createdAt: now,
    updatedAt: now,
    lastCycleAt: null,
    lastCycleId: null,
    lastTradeAt: null,
    lastTradeId: null,
    stats: {
      paperCashUsd: 10000,
      totalCycles: 0,
      totalCyclesWithTrade: 0,
      totalCyclesWithError: 0,
      avgCycleDurationMs: 0,
      totalTrades: 0,
      totalLiveTrades: 0,
      totalPaperTrades: 0,
      openPositionsCount: 0,
      winCount: 0,
      lossCount: 0,
      breakEvenCount: 0,
      totalRealizedPnlUsd: 0,
      totalFeesUsd: 0,
      totalTradeNotionalUsd: 0,
      largestWinUsd: 0,
      largestLossUsd: 0,
      avgWinUsd: 0,
      avgLossUsd: 0,
      profitFactor: null,
      peakPortfolioValueUsd: 0,
      currentDrawdownPct: 0,
      maxDrawdownPct: 0,
      maxDrawdownStartAt: null,
      maxDrawdownEndAt: null,
      sharpeRatio: null,
      sortinoRatio: null,
      lastRiskMetricsComputedAt: null,
      claudeApiCalls: 0,
      claudeApiCostUsd: 0,
      claudeAvgCostPerCycleUsd: 0,
    },
  };

  await getDb().doc(`users/${userId}/strategies/${strategyId}`).set(strategyDoc);

  await getDb().doc(`users/${userId}`).set({
    stats: {
      totalStrategies: FieldValue.increment(1),
      activeStrategies: FieldValue.increment(1),
      paperStrategies: FieldValue.increment(1),
    },
  }, { merge: true });

  return { strategyId };
}

async function createUserProfileHandler(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'create_user_profile');

  const { email, displayName, photoUrl } = request.data ?? {};
  const userRef = getDb().doc(`users/${userId}`);
  const existing = await userRef.get();

  if (existing.exists) {
    await userRef.update({
      lastActiveAt: FieldValue.serverTimestamp(),
      displayName: displayName ?? existing.data().displayName,
      photoUrl: photoUrl ?? existing.data().photoUrl,
    });
    return { userId, created: false };
  }

  await userRef.set({
    uid: userId,
    email: email ?? request.auth.token.email ?? '',
    emailVerified: request.auth.token.email_verified ?? false,
    displayName: displayName ?? '',
    photoUrl: photoUrl ?? null,
    createdAt: FieldValue.serverTimestamp(),
    lastActiveAt: FieldValue.serverTimestamp(),
    lastSeenAppVersion: '1.0.0',
    status: 'active',
    suspendedAt: null,
    suspendedReason: null,
    role: 'user',
    onboarding: { completedSteps: [], completedAt: null },
    brokers: {
      binance: { connected: false, connectedAt: null, lastVerifiedAt: null, label: null, testnetEnabled: false, lastErrorAt: null, lastErrorMessage: null },
      ibkr: { connected: false, connectedAt: null, accountId: null, lastVerifiedAt: null, tokenExpiresAt: null, label: null, lastErrorAt: null, lastErrorMessage: null },
    },
    notifications: {
      fcmTokens: [],
      fcmTokensUpdatedAt: null,
      globalEnabled: true,
      defaults: {
        onTrade: true,
        onCycle: false,
        onSignificant: true,
        onAssetSuggestion: true,
        onStrategyFlaggedForReview: true,
        dailySummary: true,
        dailySummaryHourUtc: 8,
        weeklySummary: false,
      },
    },
    stats: {
      totalStrategies: 0,
      activeStrategies: 0,
      pausedStrategies: 0,
      archivedStrategies: 0,
      liveStrategies: 0,
      paperStrategies: 0,
      totalTrades: 0,
      totalLiveTrades: 0,
      totalPaperTrades: 0,
      totalTradeNotionalUsd: 0,
      totalFeesUsd: 0,
      totalRealizedPnlUsd: 0,
      totalCycles: 0,
      lastTradeAt: null,
      lastCycleAt: null,
      claudeApiCallsTotal: 0,
      claudeApiCostUsdTotal: 0,
      claudeApiCostUsdThisMonth: 0,
      claudeCostMonthReset: new Date().toISOString().slice(0, 7),
      errorCountLast24h: 0,
      errorCountTotal: 0,
    },
    conflictResolution: { rule: 'hold_both' },
  });

  return { userId, created: true };
}

async function completeOnboardingHandler(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  const userRef = getDb().doc(`users/${userId}`);
  const existing = await userRef.get();
  if (!existing.exists) {
    throw new HttpsError('not-found', 'User profile not found');
  }

  await userRef.set({
    onboarding: {
      completedSteps: ['welcome', 'broker', 'strategy', 'paper'],
      completedAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  return { completed: true };
}

module.exports = {
  strategySetupHandler,
  strategyReinterpretHandler,
  createStrategyHandler,
  createUserProfileHandler,
  completeOnboardingHandler,
};
