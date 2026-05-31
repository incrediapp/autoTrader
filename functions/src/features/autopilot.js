const { onSchedule } = require('firebase-functions/v2/scheduler');
const { withAppSecrets } = require('../config/secrets');
const { HttpsError } = require('firebase-functions/v2/https');
const { nanoid } = require('nanoid');
const { getDb, FieldValue } = require('../utils/db');
const { callClaude, PROMPT_VERSIONS } = require('../claude/client');
const { buildAutopilotPrompt } = require('../claude/prompts');
const { parseClaudeJSON, autopilotReportSchema } = require('../claude/parser');
const { applyProposalToRules } = require('../strategy/rules');
const { sendNotification } = require('../notifications/fcm');
const { logError } = require('../monitoring/errors');
const { enforceRateLimit } = require('../utils/rateLimit');

function buildPerformanceSummary(tradeData, cycleData) {
  const wins = tradeData.filter((t) => (t.realizedPnlUsd ?? 0) > 0);
  const losses = tradeData.filter((t) => (t.realizedPnlUsd ?? 0) <= 0);

  const inactiveCycles = cycleData.filter(
    (c) => !c.tradeExecuted && c.decision?.action === 'hold',
  ).length;

  return {
    tradesAnalysed: tradeData.length,
    winRate: tradeData.length ? (wins.length / tradeData.length) * 100 : 0,
    avgWinUsd: wins.length ? wins.reduce((s, t) => s + t.realizedPnlUsd, 0) / wins.length : 0,
    avgLossUsd: losses.length ? losses.reduce((s, t) => s + t.realizedPnlUsd, 0) / losses.length : 0,
    profitFactor: losses.length
      ? Math.abs(wins.reduce((s, t) => s + t.realizedPnlUsd, 0)
        / losses.reduce((s, t) => s + t.realizedPnlUsd, 0))
      : null,
    sharpeRatio: null,
    maxDrawdownPct: 0,
    totalRealizedPnlUsd: tradeData.reduce((s, t) => s + (t.realizedPnlUsd ?? 0), 0),
    avgHoldingPeriodMs: tradeData.reduce((s, t) => s + (t.holdingPeriodMs ?? 0), 0) / (tradeData.length || 1),
    signalFrequency: tradeData.length / 4,
    inactiveCyclesPct: cycleData.length ? (inactiveCycles / cycleData.length) * 100 : 0,
    commonLossPatterns: [],
  };
}

async function runAutopilotForStrategy(strategy) {
  const { userId, strategyId } = strategy;

  const trades = await getDb()
    .collection(`users/${userId}/strategies/${strategyId}/trades`)
    .where('isClosingTrade', '==', true)
    .where('executedAt', '>', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
    .orderBy('executedAt', 'desc')
    .limit(200)
    .get();

  if (trades.size < 10) return null;

  const cycles = await getDb()
    .collection(`users/${userId}/strategies/${strategyId}/cycles`)
    .where('startedAt', '>', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    .orderBy('startedAt', 'desc')
    .limit(500)
    .get();

  const tradeData = trades.docs.map((d) => d.data());
  const cycleData = cycles.docs.map((d) => d.data());
  const summary = buildPerformanceSummary(tradeData, cycleData);

  const prompt = buildAutopilotPrompt(strategy, summary, tradeData);

  let content;
  try {
    ({ content } = await callClaude(prompt, {
      promptVersion: PROMPT_VERSIONS.AUTOPILOT,
      mode: 'autopilot',
    }));
  } catch {
    return null;
  }

  const parsed = parseClaudeJSON(content, autopilotReportSchema);
  if (!parsed.ok || !parsed.data.proposals?.length) return null;

  const reportId = `${Date.now()}_${nanoid(6)}`;
  await getDb().doc(`users/${userId}/strategies/${strategyId}/autopilotReports/${reportId}`).set({
    reportId,
    strategyId,
    userId,
    periodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    periodEnd: new Date(),
    tradesAnalysed: tradeData.length,
    cyclesAnalysed: cycleData.length,
    performanceSummary: summary,
    proposals: parsed.data.proposals,
    claudeRawResponse: content,
    promptVersion: PROMPT_VERSIONS.AUTOPILOT,
    status: 'pending',
    reviewedAt: null,
    appliedAt: null,
    appliedProposalIds: [],
    rejectedProposalIds: [],
    generatedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });

  await sendNotification(userId, 'autopilot_report_ready', strategy, {
    proposalCount: parsed.data.proposals.length,
    reportId,
  });

  return reportId;
}

const autopilotAnalysis = onSchedule(withAppSecrets({
  schedule: 'every monday 06:00',
  timeZone: 'UTC',
  timeoutSeconds: 300,
  memory: '512MiB',
}), async () => {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const strategies = await getDb().collectionGroup('strategies')
    .where('status', 'in', ['active', 'paused'])
    .get();

  for (const doc of strategies.docs) {
    const strategy = doc.data();
    const createdAt = strategy.createdAt?.toDate?.() ?? new Date(0);
    if (createdAt >= twoWeeksAgo) continue;

    try {
      await runAutopilotForStrategy(strategy);
    } catch (err) {
      await logError({
        source: 'autopilot',
        severity: 'warning',
        userId: strategy.userId,
        strategyId: strategy.strategyId,
        message: err.message,
      });
    }
  }
});

async function applyAutopilotProposalsHandler(request) {
  const { strategyId, reportId, acceptedProposalIds = [] } = request.data ?? {};
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'apply_autopilot');

  const reportRef = getDb().doc(`users/${userId}/strategies/${strategyId}/autopilotReports/${reportId}`);
  const reportSnap = await reportRef.get();
  if (!reportSnap.exists || reportSnap.data().status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Report not found or already reviewed');
  }

  const report = reportSnap.data();
  const accepted = report.proposals.filter((p) => acceptedProposalIds.includes(p.proposalId));
  const rejected = report.proposals.filter((p) => !acceptedProposalIds.includes(p.proposalId));

  const stratRef = getDb().doc(`users/${userId}/strategies/${strategyId}`);
  const strategy = (await stratRef.get()).data();
  let rules = [...(strategy.rules ?? [])];

  for (const proposal of accepted) {
    rules = applyProposalToRules(rules, proposal);
  }

  await getDb().runTransaction(async (tx) => {
    tx.update(stratRef, {
      rules,
      updatedAt: FieldValue.serverTimestamp(),
      descriptionHistory: FieldValue.arrayUnion({
        text: strategy.description,
        updatedAt: new Date(),
        claudeSummary: `Autopilot applied: ${accepted.map((p) => p.description).join('; ')}`,
      }),
    });
    tx.update(reportRef, {
      status: 'applied',
      appliedAt: FieldValue.serverTimestamp(),
      appliedProposalIds: acceptedProposalIds,
      rejectedProposalIds: rejected.map((p) => p.proposalId),
    });
  });

  return { applied: accepted.length, rejected: rejected.length };
}

async function triggerAutopilotAnalysisHandler(request) {
  const userId = request.auth?.uid;
  if (!userId) throw new HttpsError('unauthenticated', 'Authentication required');

  await enforceRateLimit(userId, 'trigger_autopilot');

  const { strategyId } = request.data ?? {};
  if (!strategyId) throw new HttpsError('invalid-argument', 'strategyId required');

  const strat = await getDb().doc(`users/${userId}/strategies/${strategyId}`).get();
  if (!strat.exists) throw new HttpsError('not-found', 'Strategy not found');

  const reportId = await runAutopilotForStrategy(strat.data());
  if (!reportId) throw new HttpsError('failed-precondition', 'Not enough trade data for autopilot analysis');

  return { reportId };
}

module.exports = {
  autopilotAnalysis,
  runAutopilotForStrategy,
  applyAutopilotProposalsHandler,
  triggerAutopilotAnalysisHandler,
  buildPerformanceSummary,
};
