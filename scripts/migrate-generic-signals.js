#!/usr/bin/env node
/**
 * Migrates strategies with DXY baseline logic to generic signals + rule_interpreter rules.
 * Usage: node scripts/migrate-generic-signals.js [userId]
 */
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '../functions/node_modules/google-auth-library'));
const { Firestore } = require(path.join(__dirname, '../functions/node_modules/@google-cloud/firestore'));

const DXY_SIGNAL = {
  id: 'dxy',
  label: 'US Dollar Index (DXY)',
  source: 'yahoo',
  symbol: 'DX-Y.NYB',
  marketKey: 'dxy',
  baselineMode: 'per_cycle',
  thresholdPct: 0.01,
  freshFetch: true,
  maxStepNotionalUsd: 500,
};

const DXY_RULES = [
  {
    ruleId: 'dxy_buy_step',
    description: 'Buy BTC when DXY falls >= 0.01% since last cycle',
    condition: 'DXY_CHANGE_SINCE_BASELINE <= -0.0001',
    action: 'BUY BTCUSDT $5 USD SCALE_STEPS',
    priority: 1,
    active: true,
    scaleByBaselineSteps: true,
    notes: 'Each 0.01% DXY down stacks $5 buy notional',
  },
  {
    ruleId: 'dxy_sell_step',
    description: 'Sell BTC when DXY rises >= 0.01% since last cycle',
    condition: 'DXY_CHANGE_SINCE_BASELINE >= 0.0001',
    action: 'SELL BTCUSDT $5 USD SCALE_STEPS',
    priority: 2,
    active: true,
    scaleByBaselineSteps: true,
    notes: 'Each 0.01% DXY up stacks $5 sell notional',
  },
];

function needsMigration(data) {
  const text = `${data.description ?? ''} ${data.claudeSummary ?? ''}`.toLowerCase();
  const mentionsDxyBaseline = text.includes('dxy')
    && (text.includes('baseline') || text.includes('0.01') || text.includes('every'));
  const hasSignals = Array.isArray(data.signals) && data.signals.length > 0;
  const pseudoRules = (data.rules ?? []).some((r) => /pct_change|Every check interval|Strategy initialization/i.test(r.condition ?? ''));
  return mentionsDxyBaseline && (!hasSignals || pseudoRules || data.decisionMode === 'autonomous_reasoner');
}

async function main() {
  const userId = process.argv[2] ?? 'ku8bedD5pMSeveZmJSlFlO8gII83';
  const configPath = `${process.env.HOME}/.config/configstore/firebase-tools.json`;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const authClient = new OAuth2Client('563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com');
  authClient.setCredentials({
    access_token: config.tokens.access_token,
    refresh_token: config.tokens.refresh_token,
    expiry_date: config.tokens.expires_at,
  });
  const db = new Firestore({ projectId: 'ai-auto-trader-a15c0', authClient });

  const snap = await db.collection(`users/${userId}/strategies`).get();
  let migrated = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (!needsMigration(data)) continue;

    const legacyDxy = data.signalState?.dxy;
    const signalState = {
      signals: {
        ...(data.signalState?.signals ?? {}),
        dxy: legacyDxy ?? data.signalState?.signals?.dxy,
      },
    };

    await doc.ref.update({
      decisionMode: 'rule_interpreter',
      signals: [DXY_SIGNAL],
      rules: DXY_RULES.map((r) => ({
        ...r,
        createdAt: new Date(),
        triggerCount: 0,
        lastTriggeredAt: null,
      })),
      signalState,
      risk: {
        ...(data.risk ?? {}),
        maxNotionalUsd: data.risk?.maxNotionalUsd ?? 500,
        dxyStepNotionalUsd: 5,
      },
      updatedAt: new Date(),
    });

    console.log(`Migrated: ${doc.id} (${data.name})`);
    migrated += 1;
  }

  console.log(`Done. ${migrated} strateg(ies) updated for user ${userId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
