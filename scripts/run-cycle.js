#!/usr/bin/env node
/**
 * Run one strategy cycle against production Firestore (uses ADC / gcloud auth).
 * Usage: node scripts/run-cycle.js qbER4Jsgbsmb
 */
const admin = require('firebase-admin');

const strategyId = process.argv[2];
if (!strategyId) {
  console.error('Usage: node scripts/run-cycle.js <strategyId>');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'ai-auto-trader-a15c0' });
}

const db = admin.firestore();

async function findStrategy(strategyId) {
  const snap = await db.collectionGroup('strategies')
    .where('strategyId', '==', strategyId)
    .limit(1)
    .get();
  if (snap.empty) throw new Error(`Strategy not found: ${strategyId}`);
  return snap.docs[0].data();
}

async function main() {
  const strategy = await findStrategy(strategyId);
  const { runStrategyLoop } = require('../functions/src/tradeLoop/strategyRunner');
  const { nanoid } = require('nanoid');

  console.log(`Running cycle for ${strategyId} (${strategy.userId})...`);
  const result = await runStrategyLoop(strategy, 'manual', nanoid(8));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.skipped && !result.error ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
