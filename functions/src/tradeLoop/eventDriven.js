const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { withAppSecrets } = require('../config/secrets');
const { getDb, FieldValue } = require('../utils/db');
const { runStrategyLoop } = require('./strategyRunner');
const { createLogContext, logInfo } = require('../monitoring/logger');

const tradeLoopOnPriceEvent = onDocumentCreated(withAppSecrets({
  document: 'priceEvents/{eventId}',
  maxInstances: 20,
  timeoutSeconds: 120,
  memory: '512MiB',
}), async (event) => {
  const data = event.data?.data();
  if (!data || data.processed) return;

  const { userId, strategyId, thresholdId } = data;
  const ctx = createLogContext('tradeLoopOnPriceEvent', userId, strategyId);

  const stratDoc = await getDb().doc(`users/${userId}/strategies/${strategyId}`).get();
  if (!stratDoc.exists || stratDoc.data().status !== 'active') {
    await event.data.ref.update({ processed: true, processedAt: FieldValue.serverTimestamp() });
    return;
  }

  logInfo(ctx, 'Price event triggered trade loop', { thresholdId });

  const result = await runStrategyLoop(
    stratDoc.data(),
    'price_event',
    null,
    { priceEventId: event.params.eventId },
  );

  await event.data.ref.update({
    processed: true,
    processedAt: FieldValue.serverTimestamp(),
    tradeLoopCycleId: result.cycleId ?? null,
  });
});

module.exports = {
  tradeLoopOnPriceEvent,
};
