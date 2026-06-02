#!/usr/bin/env node
/**
 * Copy strategies (and optional history) from one Firebase user to another.
 *
 * Requires Application Default Credentials, e.g.:
 *   gcloud auth application-default login
 *   gcloud config set project ai-auto-trader-a15c0
 *
 * List users / strategies:
 *   node scripts/copy-user-strategies.js --list-users
 *   node scripts/copy-user-strategies.js --list-strategies <userId>
 *
 * Copy all strategies (config only — fresh paper stats):
 *   node scripts/copy-user-strategies.js --from <guestUid> --to <emailUid>
 *
 * Copy one strategy with cycle + trade history:
 *   node scripts/copy-user-strategies.js --from <guestUid> --to <emailUid> \
 *     --strategy-id FhzoVNyGaM2v --with-history
 *
 * Preview without writes:
 *   node scripts/copy-user-strategies.js --from ... --to ... --dry-run
 */
const path = require('path');
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));
const { nanoid } = require(path.join(__dirname, '../functions/node_modules/nanoid'));

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'ai-auto-trader-a15c0';

const SUBCOLLECTIONS = [
  'cycles',
  'trades',
  'positions',
  'autopilotReports',
  'shadowConfigs',
  'shadowTrades',
  'monteCarloResults',
];

const REPLAY_SUBCOLLECTION = 'steps';

function parseArgs(argv) {
  const args = {
    listUsers: false,
    listStrategies: null,
    from: null,
    to: null,
    strategyIds: [],
    withHistory: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--list-users':
        args.listUsers = true;
        break;
      case '--list-strategies':
        args.listStrategies = argv[i + 1];
        i += 1;
        break;
      case '--from':
        args.from = argv[i + 1];
        i += 1;
        break;
      case '--to':
        args.to = argv[i + 1];
        i += 1;
        break;
      case '--strategy-id':
        args.strategyIds.push(argv[i + 1]);
        i += 1;
        break;
      case '--with-history':
        args.withHistory = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.error(`Usage:
  node scripts/copy-user-strategies.js --list-users
  node scripts/copy-user-strategies.js --list-strategies <userId>
  node scripts/copy-user-strategies.js --from <sourceUid> --to <targetUid> [--strategy-id <id>] [--with-history] [--dry-run]`);
}

function initAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT_ID });
  }
  return admin.firestore();
}

function formatUserLine(doc) {
  const data = doc.data();
  const email = data.email || '(no email)';
  const name = data.displayName || '(no name)';
  const stats = data.stats ?? {};
  return `${doc.id}  ${email.padEnd(28)} ${name.padEnd(16)} strategies=${stats.totalStrategies ?? 0}`;
}

async function listUsers(db) {
  const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(50).get();
  if (snap.empty) {
    console.log('No users found.');
    return;
  }
  console.log('UID                          EMAIL                        NAME             STATS');
  for (const doc of snap.docs) {
    console.log(formatUserLine(doc));
  }
}

async function listStrategies(db, userId) {
  const snap = await db.collection(`users/${userId}/strategies`).get();
  if (snap.empty) {
    console.log(`No strategies for ${userId}`);
    return;
  }
  for (const doc of snap.docs) {
    const s = doc.data();
    console.log(
      `${doc.id}  ${s.name ?? '(unnamed)'}  mode=${s.mode} status=${s.status} trades=${s.stats?.totalTrades ?? 0}`,
    );
  }
}

function cloneForTargetUser(data, targetUserId, newStrategyId, withHistory) {
  const copy = JSON.parse(JSON.stringify(data));

  copy.strategyId = newStrategyId;
  copy.userId = targetUserId;

  if (!withHistory) {
    copy.mode = 'paper';
    copy.liveEnabledAt = null;
    copy.paperStartedAt = admin.firestore.FieldValue.serverTimestamp();
    copy.lastCycleAt = null;
    copy.lastCycleId = null;
    copy.lastTradeAt = null;
    copy.lastTradeId = null;
    copy.pendingOrderIds = [];
    copy.brokerHealth = {
      lastSuccessfulCycleAt: null,
      consecutiveFailures: 0,
      brokerUnreachable: false,
      brokerUnreachableAt: null,
    };
    copy.stats = {
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
    };
  }

  copy.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  if (!copy.createdAt) {
    copy.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  return copy;
}

async function copyCollection(db, sourcePath, targetPath, dryRun) {
  const snap = await db.collection(sourcePath).get();
  if (snap.empty) return 0;

  if (dryRun) return snap.size;

  const batchSize = 400;
  let written = 0;
  for (let i = 0; i < snap.docs.length; i += batchSize) {
    const batch = db.batch();
    const chunk = snap.docs.slice(i, i + batchSize);
    for (const doc of chunk) {
      batch.set(db.doc(`${targetPath}/${doc.id}`), doc.data());
      written += 1;
    }
    await batch.commit();
  }
  return written;
}

async function copyReplaySessions(db, sourceStrategyPath, targetStrategyPath, dryRun) {
  const sessions = await db.collection(`${sourceStrategyPath}/replaySessions`).get();
  if (sessions.empty) return 0;

  let count = 0;
  for (const sessionDoc of sessions.docs) {
    if (!dryRun) {
      await db.doc(`${targetStrategyPath}/replaySessions/${sessionDoc.id}`).set(sessionDoc.data());
    }
    const stepsCopied = await copyCollection(
      db,
      `${sourceStrategyPath}/replaySessions/${sessionDoc.id}/${REPLAY_SUBCOLLECTION}`,
      `${targetStrategyPath}/replaySessions/${sessionDoc.id}/${REPLAY_SUBCOLLECTION}`,
      dryRun,
    );
    count += 1 + stepsCopied;
  }
  return count;
}

async function copyStrategy(db, sourceUserId, targetUserId, sourceStrategyId, options) {
  const sourceRef = db.doc(`users/${sourceUserId}/strategies/${sourceStrategyId}`);
  const sourceSnap = await sourceRef.get();
  if (!sourceSnap.exists) {
    throw new Error(`Strategy not found: users/${sourceUserId}/strategies/${sourceStrategyId}`);
  }

  const newStrategyId = nanoid(12);
  const targetRef = db.doc(`users/${targetUserId}/strategies/${newStrategyId}`);
  const strategyData = cloneForTargetUser(
    sourceSnap.data(),
    targetUserId,
    newStrategyId,
    options.withHistory,
  );

  if (options.dryRun) {
    console.log(`[dry-run] would copy ${sourceStrategyId} -> ${newStrategyId} (${strategyData.name})`);
  } else {
    await targetRef.set(strategyData);
    console.log(`Copied strategy "${strategyData.name}": ${sourceStrategyId} -> ${newStrategyId}`);
  }

  if (!options.withHistory) {
    return { sourceStrategyId, newStrategyId, name: strategyData.name };
  }

  const sourceBase = `users/${sourceUserId}/strategies/${sourceStrategyId}`;
  const targetBase = `users/${targetUserId}/strategies/${newStrategyId}`;

  for (const sub of SUBCOLLECTIONS) {
    const n = await copyCollection(db, `${sourceBase}/${sub}`, `${targetBase}/${sub}`, options.dryRun);
    if (n > 0) {
      console.log(`  ${sub}: ${n} docs`);
    }
  }

  const replayCount = await copyReplaySessions(db, sourceBase, targetBase, options.dryRun);
  if (replayCount > 0) {
    console.log(`  replaySessions (+steps): ${replayCount} docs`);
  }

  return { sourceStrategyId, newStrategyId, name: strategyData.name };
}

async function bumpUserStats(db, targetUserId, count, dryRun) {
  if (count <= 0 || dryRun) return;
  await db.doc(`users/${targetUserId}`).set({
    stats: {
      totalStrategies: admin.firestore.FieldValue.increment(count),
      activeStrategies: admin.firestore.FieldValue.increment(count),
      paperStrategies: admin.firestore.FieldValue.increment(count),
    },
  }, { merge: true });
}

async function main() {
  const args = parseArgs(process.argv);
  const db = initAdmin();

  if (args.listUsers) {
    await listUsers(db);
    return;
  }

  if (args.listStrategies) {
    await listStrategies(db, args.listStrategies);
    return;
  }

  if (!args.from || !args.to) {
    usage();
    process.exit(1);
  }

  if (args.from === args.to) {
    throw new Error('Source and target user must differ');
  }

  const [sourceUser, targetUser] = await Promise.all([
    db.doc(`users/${args.from}`).get(),
    db.doc(`users/${args.to}`).get(),
  ]);

  if (!sourceUser.exists) throw new Error(`Source user not found: ${args.from}`);
  if (!targetUser.exists) throw new Error(`Target user not found: ${args.to}`);

  const sourceStrategies = await db.collection(`users/${args.from}/strategies`).get();
  if (sourceStrategies.empty) {
    console.log('No strategies to copy.');
    return;
  }

  const toCopy = args.strategyIds.length
    ? sourceStrategies.docs.filter((d) => args.strategyIds.includes(d.id))
    : sourceStrategies.docs;

  if (toCopy.length === 0) {
    throw new Error(`No matching strategies. Available: ${sourceStrategies.docs.map((d) => d.id).join(', ')}`);
  }

  console.log(
    `${args.dryRun ? '[dry-run] ' : ''}Copying ${toCopy.length} strateg(ies) `
    + `from ${args.from} (${sourceUser.data().email || 'guest'}) `
    + `to ${args.to} (${targetUser.data().email || 'unknown'})`
    + `${args.withHistory ? ' with history' : ' (config only)'}`,
  );

  const results = [];
  for (const doc of toCopy) {
    results.push(await copyStrategy(db, args.from, args.to, doc.id, args));
  }

  await bumpUserStats(db, args.to, results.length, args.dryRun);

  console.log('\nDone:');
  for (const r of results) {
    console.log(`  ${r.name}: ${r.sourceStrategyId} -> ${r.newStrategyId}`);
  }
  console.log('\nNote: broker API keys are per-user in Secret Manager — reconnect Binance/IBKR on the target account.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
