const { getMessaging } = require('firebase-admin/messaging');
const { getDb } = require('../utils/db');
const { incrementSystemMetric } = require('../monitoring/metrics');
const { logError } = require('../monitoring/errors');

const NOTIFICATION_TITLES = {
  trade_executed: 'Trade Executed',
  cycle_complete: 'Cycle Complete',
  drawdown_limit_hit: 'Drawdown Limit Hit',
  asset_suggested: 'Asset Suggestion',
  strategy_flagged_for_review: 'Strategy Needs Review',
  stop_loss_triggered: 'Stop Loss Triggered',
  broker_error: 'Broker Error',
  emergency_sell_executed: 'Emergency Sell Complete',
  post_mortem_ready: 'Trade Analysis Ready',
  autopilot_report_ready: 'Autopilot Report Ready',
  ibkr_session_expired: 'IBKR Session Expired',
  strategy_conflict: 'Strategy Conflict',
  macro_event_soon: 'Macro Event Approaching',
};

async function sendFCMToTokens(tokens, { title, body, data = {} }) {
  if (!tokens.length) return { success: 0, failure: 0 };

  const messaging = getMessaging();
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    stringData[k] = String(v ?? '');
  }

  try {
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
    });

    await incrementSystemMetric('fcmSentToday', result.successCount);
    if (result.failureCount > 0) {
      await incrementSystemMetric('fcmFailedToday', result.failureCount);
    }

    return { success: result.successCount, failure: result.failureCount };
  } catch (err) {
    await incrementSystemMetric('fcmFailedToday', tokens.length);
    throw err;
  }
}

async function sendNotification(userId, type, strategy, payload = {}) {
  try {
    const userDoc = await getDb().doc(`users/${userId}`).get();
    if (!userDoc.exists) return;

    const user = userDoc.data();
    if (!user.notifications?.globalEnabled) return;

    const useDefaults = strategy?.notifications?.useDefaults !== false;
    const notifConfig = useDefaults
      ? user.notifications?.defaults
      : strategy?.notifications;

    const typeMap = {
      trade_executed: notifConfig?.onTrade,
      cycle_complete: notifConfig?.onCycle,
      drawdown_limit_hit: notifConfig?.onSignificant,
      asset_suggested: notifConfig?.onAssetSuggestion ?? user.notifications?.defaults?.onAssetSuggestion,
      strategy_flagged_for_review: user.notifications?.defaults?.onStrategyFlaggedForReview,
      stop_loss_triggered: notifConfig?.onSignificant ?? notifConfig?.onTrade,
      broker_error: notifConfig?.onSignificant,
      emergency_sell_executed: true,
      post_mortem_ready: notifConfig?.onTrade,
      autopilot_report_ready: true,
      ibkr_session_expired: true,
      strategy_conflict: notifConfig?.onSignificant,
      macro_event_soon: notifConfig?.onSignificant,
    };

    if (typeMap[type] === false) return;

    const tokens = user.notifications?.fcmTokens ?? [];
    if (!tokens.length) return;

    const title = NOTIFICATION_TITLES[type] ?? 'AI Auto Trader';
    let body = payload.message ?? payload.preview ?? 'You have a new notification';

    if (type === 'trade_executed') {
      body = `${payload.side?.toUpperCase() ?? 'Trade'} ${payload.symbol ?? ''} — $${(payload.executedNotionalUsd ?? 0).toFixed(2)}`;
    } else if (type === 'strategy_conflict') {
      body = `Conflict on ${payload.symbol}: ${payload.strategyAName} vs ${payload.strategyBName}`;
    }

    await sendFCMToTokens(tokens, { title, body, data: { type, ...payload } });
  } catch (err) {
    await logError({
      source: 'notification',
      severity: 'warning',
      userId,
      message: `FCM send failed: ${err.message}`,
      metadata: { type },
    });
  }
}

module.exports = {
  sendNotification,
  sendFCMToTokens,
};
