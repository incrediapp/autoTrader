#!/usr/bin/env node
/**
 * Run guest→email strategy migration using Firebase CLI credentials.
 *
 *   node scripts/run-migrate.js <sourceUid> <targetUid> [--config-only]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { OAuth2Client } = require(path.join(root, 'functions/node_modules/google-auth-library'));
const { Firestore } = require(path.join(root, 'functions/node_modules/@google-cloud/firestore'));

const sourceUserId = process.argv[2];
const targetUserId = process.argv[3];
const withHistory = !process.argv.includes('--config-only');

if (!sourceUserId || !targetUserId) {
  console.error('Usage: node scripts/run-migrate.js <sourceUid> <targetUid> [--config-only]');
  process.exit(1);
}

const configPath = path.join(process.env.HOME, '.config/configstore/firebase-tools.json');
if (!fs.existsSync(configPath)) {
  console.error('Firebase CLI not logged in. Run: firebase login');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const clientId = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';

async function main() {
  const authClient = new OAuth2Client(clientId);
  authClient.setCredentials({
    access_token: config.tokens.access_token,
    refresh_token: config.tokens.refresh_token,
    expiry_date: config.tokens.expires_at,
  });

  const firestore = new Firestore({
    projectId: process.env.FIREBASE_PROJECT_ID || 'ai-auto-trader-a15c0',
    authClient,
  });

  const { copyStrategiesBetweenUsers } = require(path.join(root, 'functions/src/strategy/migrate'));

  const result = await copyStrategiesBetweenUsers({
    sourceUserId,
    targetUserId,
    withHistory,
    db: firestore,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
