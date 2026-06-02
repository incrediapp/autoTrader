const { onSchedule } = require('firebase-functions/v2/scheduler');
const { withAppSecrets } = require('../config/secrets');
const { getDb, FieldValue } = require('../utils/db');
const { fetchMarketData } = require('./marketData');
const { createLogContext, logInfo } = require('../monitoring/logger');

const priceMonitor = onSchedule(withAppSecrets({
  schedule: 'every 20 minutes',
  timeZone: 'UTC',
  maxInstances: 2,
  timeoutSeconds: 120,
  memory: '512MiB',
}), async () => {
  const ctx = createLogContext('priceMonitor');
  logInfo(ctx, 'Price monitor starting');

  const strategies = await getDb()
    .collectionGroup('strategies')
    .where('status', '==', 'active')
    .get();

  for (const doc of strategies.docs) {
    const strategy = doc.data();
    const thresholds = strategy.schedule?.priceThresholds ?? [];

    for (const threshold of thresholds.filter((t) => t.active)) {
      try {
        let marketSnapshot;
        try {
          marketSnapshot = await fetchMarketData(strategy, strategy.userId);
        } catch {
          continue;
        }

        const asset = marketSnapshot.assets.find((a) => a.symbol === threshold.symbol);
        if (!asset) continue;

        let currentValue;
        switch (threshold.triggerType) {
          case 'rsi':
            currentValue = asset.rsi14;
            break;
          case 'volume':
            currentValue = asset.volume24h;
            break;
          default:
            currentValue = asset.price;
        }

        if (currentValue == null) continue;

        const triggered = threshold.direction === 'above'
          ? currentValue >= threshold.value
          : currentValue <= threshold.value;

        if (!triggered) continue;

        if (threshold.lastTriggeredAt) {
          const lastMs = threshold.lastTriggeredAt.toMillis?.()
            ?? new Date(threshold.lastTriggeredAt).getTime();
          const cooldownMs = (threshold.cooldownMinutes ?? 60) * 60 * 1000;
          if (Date.now() - lastMs < cooldownMs) continue;
        }

        const eventId = `${strategy.userId}_${strategy.strategyId}_${threshold.symbol}_${threshold.thresholdId}`;

        await getDb().doc(`priceEvents/${eventId}`).set({
          userId: strategy.userId,
          strategyId: strategy.strategyId,
          symbol: threshold.symbol,
          thresholdId: threshold.thresholdId,
          triggerType: threshold.triggerType,
          direction: threshold.direction,
          currentValue,
          thresholdValue: threshold.value,
          detectedAt: FieldValue.serverTimestamp(),
          processed: false,
          processedAt: null,
          tradeLoopCycleId: null,
          expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }, { merge: true });

        const updatedThresholds = thresholds.map((t) =>
          t.thresholdId === threshold.thresholdId
            ? { ...t, lastTriggeredAt: new Date() }
            : t,
        );

        await doc.ref.update({ 'schedule.priceThresholds': updatedThresholds });
      } catch (err) {
        logInfo(ctx, `Threshold check failed: ${err.message}`, { strategyId: strategy.strategyId });
      }
    }
  }
});

module.exports = {
  priceMonitor,
};
