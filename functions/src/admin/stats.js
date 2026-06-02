const { onSchedule } = require('firebase-functions/v2/scheduler');
const { withAppSecrets } = require('../config/secrets');
const { getDb, FieldValue } = require('../utils/db');
const { buildSystemMetricsSnapshot } = require('../monitoring/metrics');
const { computeAnnualisedSharpe, computeAnnualisedSortino } = require('../utils/helpers');
const { getIBKROrderStatus } = require('../brokers/ibkr');
const { updatePositionAfterTrade } = require('../positions/fifo');
const { applyRealizedPnlToStrategy } = require('../strategy/statsSync');
const { sendNotification } = require('../notifications/fcm');
const { logError } = require('../monitoring/errors');
const { callClaude } = require('../claude/client');
const { buildDailySummaryPrompt } = require('../claude/prompts');
const { parseClaudeJSON } = require('../claude/parser');
const { refreshEarningsCalendarData } = require('../features/earningsCalendar');
const { refreshMacroCalendarData } = require('../features/macroCalendar');

const computeDailyStats = onSchedule(withAppSecrets({
  schedule: '5 0 * * *',
  timeZone: 'UTC',
  maxInstances: 1,
  timeoutSeconds: 540,
  memory: '1GiB',
}), async () => {
  const today = new Date().toISOString().split('T')[0];
  const systemSnapshot = await buildSystemMetricsSnapshot();

  await getDb().doc(`systemMetrics/${today}`).set({
    ...systemSnapshot,
    date: today,
    capturedAt: FieldValue.serverTimestamp(),
  });

  await getDb().doc('systemMetrics/current').set({
    cyclesToday: 0,
    tradesToday: 0,
    liveTradesToday: 0,
    paperTradesToday: 0,
    notionalVolumeUsdToday: 0,
    claudeCallsToday: 0,
    claudeCostUsdToday: 0,
    binanceApiErrorsToday: 0,
    ibkrApiErrorsToday: 0,
    fcmSentToday: 0,
    fcmFailedToday: 0,
    errorCyclesToday: 0,
    newUsersToday: 0,
    activeUsersLast24h: 0,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const strategies = await getDb().collectionGroup('strategies')
    .where('status', 'in', ['active', 'paused'])
    .get();

  for (const stratDoc of strategies.docs) {
    const strategy = stratDoc.data();
    const trades = await getDb()
      .collection(`users/${strategy.userId}/strategies/${strategy.strategyId}/trades`)
      .where('isClosingTrade', '==', true)
      .where('mode', '==', 'live')
      .orderBy('executedAt', 'desc')
      .limit(365)
      .get();

    if (trades.size < 5) continue;

    const pnlSeries = trades.docs.map((d) => d.data().realizedPnlPct ?? 0);
    await stratDoc.ref.update({
      'stats.sharpeRatio': computeAnnualisedSharpe(pnlSeries),
      'stats.sortinoRatio': computeAnnualisedSortino(pnlSeries),
      'stats.lastRiskMetricsComputedAt': FieldValue.serverTimestamp(),
    });
  }
});

const ibkrFillPoller = onSchedule(withAppSecrets({
  schedule: 'every 2 minutes',
  maxInstances: 1,
  timeoutSeconds: 60,
}), async () => {
  const pending = await getDb().collection('ibkrPendingFills')
    .where('status', '==', 'pending')
    .get();

  for (const doc of pending.docs) {
    const fill = doc.data();

    if (fill.checkCount > 20) {
      await doc.ref.update({ status: 'timeout', resolvedAt: FieldValue.serverTimestamp() });
      await logError({
        source: 'broker_ibkr',
        severity: 'error',
        userId: fill.userId,
        strategyId: fill.strategyId,
        message: `IBKR order ${fill.brokerOrderId} timed out after 40 minutes`,
      });
      await sendNotification(fill.userId, 'broker_error', null, {
        message: `Order for ${fill.symbol} timed out.`,
      });
      continue;
    }

    try {
      const orderStatus = await getIBKROrderStatus(fill.userId, fill.brokerOrderId);

      if (orderStatus.status === 'Filled') {
        const tradeRef = getDb().doc(
          `users/${fill.userId}/strategies/${fill.strategyId}/trades/${fill.tradeId}`,
        );
        await tradeRef.update({
          brokerStatus: 'filled',
          executedPriceUsd: orderStatus.avgPrice,
          executedQuantity: orderStatus.filledQuantity,
          executedNotionalUsd: orderStatus.avgPrice * orderStatus.filledQuantity,
          feeUsd: orderStatus.commission ?? 0,
          fillConfirmedAt: FieldValue.serverTimestamp(),
          executedAt: FieldValue.serverTimestamp(),
        });

        await updatePositionAfterTrade(
          { strategyId: fill.strategyId, assets: { broker: 'ibkr' } },
          fill.userId,
          { side: fill.side, symbol: fill.symbol },
          orderStatus.filledQuantity,
          orderStatus.avgPrice,
          fill.tradeId,
        );

        const filledTrade = (await tradeRef.get()).data();
        if (filledTrade?.realizedPnlUsd != null) {
          const strategyRef = getDb().doc(
            `users/${fill.userId}/strategies/${fill.strategyId}`,
          );
          await applyRealizedPnlToStrategy(strategyRef, filledTrade.realizedPnlUsd);
        }

        await doc.ref.update({ status: 'filled', resolvedAt: FieldValue.serverTimestamp() });
      } else if (['Cancelled', 'Inactive'].includes(orderStatus.status)) {
        await doc.ref.update({ status: 'failed', resolvedAt: FieldValue.serverTimestamp() });
      } else {
        await doc.ref.update({
          lastCheckedAt: FieldValue.serverTimestamp(),
          checkCount: FieldValue.increment(1),
        });
      }
    } catch (err) {
      await doc.ref.update({
        lastCheckedAt: FieldValue.serverTimestamp(),
        checkCount: FieldValue.increment(1),
      });
    }
  }
});

const sendDailySummaries = onSchedule(withAppSecrets({
  schedule: 'every 1 hours',
  timeZone: 'UTC',
  timeoutSeconds: 120,
  memory: '512MiB',
}), async () => {
  const currentHourUtc = new Date().getUTCHours();

  const users = await getDb().collection('users')
    .where('status', '==', 'active')
    .get();

  for (const userDoc of users.docs) {
    const user = userDoc.data();
    const hour = user.notifications?.defaults?.dailySummaryHourUtc ?? 8;
    if (hour !== currentHourUtc || !user.notifications?.defaults?.dailySummary) continue;

    const strategies = await getDb().collection(`users/${userDoc.id}/strategies`)
      .where('status', '==', 'active')
      .get();

    const stats = {
      currentValue: user.stats?.totalTradeNotionalUsd ?? 0,
      pctChange: 0,
      tradesCount: user.stats?.totalTrades ?? 0,
      wins: 0,
      losses: 0,
      realizedPnl: user.stats?.totalRealizedPnlUsd ?? 0,
      activeCount: strategies.size,
      pausedCount: 0,
      cyclesCount: user.stats?.totalCycles ?? 0,
      claudeCost: user.stats?.claudeApiCostUsdThisMonth ?? 0,
      errors: user.stats?.errorCountLast24h ?? 0,
    };

    try {
      const { content } = await callClaude(buildDailySummaryPrompt(stats), { mode: 'daily_summary' });
      const parsed = parseClaudeJSON(content);
      if (parsed.ok) {
        await sendNotification(userDoc.id, 'cycle_complete', null, {
          message: parsed.data.summary,
          type: 'daily_summary',
        });
      }
    } catch {
      // skip if Claude unavailable
    }
  }
});

const cleanupExpiredData = onSchedule(withAppSecrets({
  schedule: '0 2 * * *',
  timeZone: 'UTC',
  maxInstances: 1,
  timeoutSeconds: 300,
}), async () => {
  // Firestore TTL policies handle most cleanup; this is a safety net for rate limit docs
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rateLimits = await getDb().collection('rateLimits').limit(100).get();

  const batch = getDb().batch();
  let count = 0;
  for (const doc of rateLimits.docs) {
    const lastReset = doc.data().lastReset ?? 0;
    if (lastReset < cutoff) {
      batch.delete(doc.ref);
      count++;
    }
  }
  if (count > 0) await batch.commit();
});

const refreshEarningsCalendar = onSchedule(withAppSecrets({
  schedule: 'every day 06:00',
  timeZone: 'UTC',
  timeoutSeconds: 120,
}), refreshEarningsCalendarData);

const refreshMacroCalendar = onSchedule(withAppSecrets({
  schedule: 'every day 05:00',
  timeZone: 'UTC',
  timeoutSeconds: 60,
}), refreshMacroCalendarData);

module.exports = {
  computeDailyStats,
  ibkrFillPoller,
  sendDailySummaries,
  cleanupExpiredData,
  refreshEarningsCalendar,
  refreshMacroCalendar,
};
