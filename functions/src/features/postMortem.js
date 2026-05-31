const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { withAppSecrets } = require('../config/secrets');
const { getDb, FieldValue } = require('../utils/db');
const { callClaude, PROMPT_VERSIONS } = require('../claude/client');
const { buildPostMortemPrompt } = require('../claude/prompts');
const { parseClaudeJSON, postMortemSchema, estimateCost } = require('../claude/parser');
const { sendNotification } = require('../notifications/fcm');

async function enqueuePostMortemIfNeeded(trade, strategy, userId) {
  if (!trade?.isClosingTrade && trade?.side !== 'sell') return;

  const pnlPct = trade.realizedPnlPct ?? 0;
  const isSignificantLoss = pnlPct < -2.0 || trade.source === 'stop_loss';
  const isSignificantWin = pnlPct > 5.0;

  if (!isSignificantLoss && !isSignificantWin) return;

  const tradeId = trade.tradeId;
  await getDb().collection('postMortemQueue').doc(tradeId).set({
    tradeId,
    userId,
    strategyId: strategy.strategyId,
    cycleId: trade.cycleId,
    type: isSignificantLoss ? 'loss_analysis' : 'win_analysis',
    createdAt: FieldValue.serverTimestamp(),
    processed: false,
    processedAt: null,
    expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}

async function processPostMortem(data) {
  const { tradeId, userId, strategyId, cycleId, type } = data;

  const [tradeDoc, cycleDoc, strategyDoc] = await Promise.all([
    getDb().doc(`users/${userId}/strategies/${strategyId}/trades/${tradeId}`).get(),
    getDb().doc(`users/${userId}/strategies/${strategyId}/cycles/${cycleId}`).get(),
    getDb().doc(`users/${userId}/strategies/${strategyId}`).get(),
  ]);

  const trade = tradeDoc.data();
  const cycle = cycleDoc.data();
  const strategy = strategyDoc.data();

  if (!trade || !strategy) return;

  let openingTrade = null;
  if (trade.openingTradeIds?.length > 0) {
    const openingDoc = await getDb().doc(
      `users/${userId}/strategies/${strategyId}/trades/${trade.openingTradeIds[0]}`,
    ).get();
    openingTrade = openingDoc.data();
  }

  const prompt = buildPostMortemPrompt(trade, cycle, strategy, openingTrade, type);

  try {
    const { content, usage } = await callClaude(prompt, {
      promptVersion: PROMPT_VERSIONS.POST_MORTEM,
      mode: 'post_mortem',
    });
    const parsed = parseClaudeJSON(content, postMortemSchema);

    if (parsed.ok) {
      await getDb().doc(`users/${userId}/strategies/${strategyId}/trades/${tradeId}`).update({
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

      await sendNotification(userId, 'post_mortem_ready', strategy, {
        tradeId,
        type,
        preview: parsed.data.summary.slice(0, 80),
      });
    }
  } catch {
    // optional feature — degrade gracefully
  }
}

const postMortemProcessor = onDocumentCreated(withAppSecrets({
  document: 'postMortemQueue/{tradeId}',
  timeoutSeconds: 120,
  memory: '512MiB',
}), async (event) => {
  const data = event.data?.data();
  if (!data) return;

  await processPostMortem(data);

  await event.data.ref.update({
    processed: true,
    processedAt: FieldValue.serverTimestamp(),
  });
});

module.exports = {
  enqueuePostMortemIfNeeded,
  processPostMortem,
  postMortemProcessor,
};
