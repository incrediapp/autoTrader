#!/usr/bin/env node
/**
 * Verify IBKR OAuth credentials from repo-root .env (and PEM files).
 * Usage: node scripts/verify-ibkr-oauth.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`Missing ${ENV_FILE}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i);
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function dhPrimeFromPem(pemPath) {
  return execSync(
    `openssl dhparam -in "${pemPath}" -text 2>/dev/null | sed -n '/prime:/,/generator:/p' | grep -v generator | tr -d ' \\n:' | sed 's/prime//'`,
    { encoding: 'utf8', shell: '/bin/bash' },
  ).trim().toLowerCase();
}

function resolvePem(envPathKey) {
  const rel = process.env[envPathKey];
  if (!rel) return null;
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

async function main() {
  loadEnv();

  const required = [
    'IBKR_OAUTH_CONSUMER_KEY',
    'IBKR_OAUTH_ACCESS_TOKEN',
    'IBKR_OAUTH_ACCESS_TOKEN_SECRET',
    'IBKR_OAUTH_DH_PRIME',
  ];
  const missing = required.filter((k) => !(process.env[k] || '').trim());
  if (missing.length) {
    console.error('Missing in .env:', missing.join(', '));
    process.exit(1);
  }

  const sigPath = resolvePem('IBKR_OAUTH_SIGNATURE_PEM_PATH');
  const encPath = resolvePem('IBKR_OAUTH_ENCRYPTION_PEM_PATH');
  const dhPath = path.join(ROOT, 'secrets/ibkr/dhparam.pem');

  for (const [label, p] of [['signature', sigPath], ['encryption', encPath]]) {
    if (!p || !fs.existsSync(p)) {
      console.error(`Missing ${label} PEM: ${p ?? '(path not set)'}`);
      process.exit(1);
    }
    process.env[`IBKR_OAUTH_PRIVATE_${label.toUpperCase()}`] = fs.readFileSync(p, 'utf8');
  }

  if (fs.existsSync(dhPath)) {
    const fromPem = dhPrimeFromPem(dhPath);
    const fromEnv = process.env.IBKR_OAUTH_DH_PRIME.replace(/\s/g, '').toLowerCase();
    if (fromPem !== fromEnv) {
      console.error('IBKR_OAUTH_DH_PRIME does not match secrets/ibkr/dhparam.pem.');
      console.error('Regenerate with: ./scripts/generate-ibkr-oauth-keys.sh');
      console.error('Use the printed IBKR_OAUTH_DH_PRIME line, re-upload the same dhparam.pem in the IBKR portal, then sync secrets.');
      process.exit(1);
    }
    console.log('DH prime matches dhparam.pem');
  }

  const secret = process.env.IBKR_OAUTH_ACCESS_TOKEN_SECRET.trim();
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length > 200) {
    console.warn(
      'Warning: access token secret looks like hex from decrypt-ibkr-access-token-secret.sh.',
      'ibkr-client expects the portal value (base64), not decrypted hex.',
    );
  }

  process.chdir(path.join(ROOT, 'functions'));
  const { pingIbkrCredentials, resetIbkrSession } = require('../functions/src/brokers/ibkrSession');
  resetIbkrSession();

  try {
    await pingIbkrCredentials();
    console.log('IBKR OAuth ping OK (/portfolio/accounts)');
  } catch (err) {
    console.error('IBKR OAuth ping failed:', err.message);
    process.exit(1);
  }
}

main();
