const { HttpsError } = require('firebase-functions/v2/https');
const { getDb } = require('./db');

/** Set true to enforce limits and write rateLimits/{userId}_{action} in Firestore. */
const RATE_LIMITS_ENABLED = false;

const DEFAULT_LIMITS = {
  // Multi-turn setup chat: one call per user message; allow a full clarification session.
  strategy_setup: { maxCalls: 20, windowSeconds: 3600 },
  strategy_reinterpret: { maxCalls: 15, windowSeconds: 3600 },
  create_strategy: { maxCalls: 10, windowSeconds: 3600 },
  connect_broker: { maxCalls: 5, windowSeconds: 3600 },
  verify_broker: { maxCalls: 10, windowSeconds: 3600 },
  disconnect_broker: { maxCalls: 5, windowSeconds: 3600 },
  emergency_sell: { maxCalls: 1, windowSeconds: 60 },
  emergency_sell_strategy: { maxCalls: 3, windowSeconds: 60 },
  manual_cycle: { maxCalls: 3, windowSeconds: 60 },
  generate_trade_export: { maxCalls: 2, windowSeconds: 3600 },
  toggle_strategy_status: { maxCalls: 20, windowSeconds: 3600 },
  switch_strategy_mode: { maxCalls: 10, windowSeconds: 3600 },
  get_analytics: { maxCalls: 30, windowSeconds: 3600 },
  refresh_macro_calendar: { maxCalls: 10, windowSeconds: 3600 },
  update_fcm_token: { maxCalls: 20, windowSeconds: 3600 },
  apply_autopilot: { maxCalls: 5, windowSeconds: 3600 },
  trigger_autopilot: { maxCalls: 3, windowSeconds: 3600 },
  monte_carlo: { maxCalls: 5, windowSeconds: 3600 },
  replay_session: { maxCalls: 3, windowSeconds: 86400 },
  resolve_conflict: { maxCalls: 10, windowSeconds: 3600 },
  migrate_guest_strategies: { maxCalls: 5, windowSeconds: 86400 },
  create_user_profile: { maxCalls: 5, windowSeconds: 3600 },
  admin_suspend_user: { maxCalls: 20, windowSeconds: 3600 },
  admin_promote_user: { maxCalls: 10, windowSeconds: 3600 },
  admin_resolve_error: { maxCalls: 30, windowSeconds: 3600 },
};

async function enforceRateLimit(userId, action, maxCalls, windowSeconds) {
  if (!RATE_LIMITS_ENABLED) return;

  const limits = DEFAULT_LIMITS[action];
  const max = maxCalls ?? limits?.maxCalls ?? 10;
  const window = windowSeconds ?? limits?.windowSeconds ?? 3600;

  const key = `rateLimits/${userId}_${action}`;
  const now = Date.now();
  const windowStart = now - window * 1000;

  const doc = await getDb().doc(key).get();
  const data = doc.data() ?? { calls: [] };

  const recentCalls = (data.calls ?? []).filter((t) => t > windowStart);

  if (recentCalls.length >= max) {
    const oldestInWindow = Math.min(...recentCalls);
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + window * 1000 - now) / 1000));
    throw new HttpsError(
      'resource-exhausted',
      `Rate limit exceeded: ${max} calls per ${window}s for ${action}`,
      { action, retryAfterSeconds },
    );
  }

  recentCalls.push(now);
  await getDb().doc(key).set({
    calls: recentCalls,
    lastReset: now,
    expireAt: new Date(now + window * 1000),
  });
}

module.exports = {
  enforceRateLimit,
  DEFAULT_LIMITS,
};
