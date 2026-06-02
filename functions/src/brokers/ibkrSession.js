const fs = require('fs');
const path = require('path');
const { configureIbkrNetwork, fetchCloudEgressIp } = require('./ibkrNetwork');
const { IbkrClient } = require('ibkr-client');

configureIbkrNetwork();
const {
  getSecret,
  getSecretSource,
  clearSecretCache,
  pemFingerprint,
  getIbkrSecretFingerprints,
} = require('../utils/secrets');
const { normalizeDhPrime } = require('./ibkrDhPrime');

let clientPromise = null;
let initPromise = null;

async function readSecretOrPemFile(secretName, pathEnvVar) {
  try {
    return await getSecret(secretName);
  } catch (err) {
    const filePath = process.env[pathEnvVar];
    if ((process.env.FUNCTIONS_EMULATOR || process.env.NODE_ENV === 'test') && filePath) {
      const resolved = path.resolve(process.cwd(), filePath);
      return fs.readFileSync(resolved, 'utf8');
    }
    throw err;
  }
}

async function loadOAuthConfig() {
  const [
    consumerKey,
    accessToken,
    accessTokenSecret,
    dhPrime,
    signature,
    encryption,
  ] = await Promise.all([
    getSecret('ibkr_oauth_consumer_key'),
    getSecret('ibkr_oauth_access_token'),
    getSecret('ibkr_oauth_access_token_secret'),
    getSecret('ibkr_oauth_dh_prime'),
    readSecretOrPemFile('ibkr_oauth_private_signature', 'IBKR_OAUTH_SIGNATURE_PEM_PATH'),
    readSecretOrPemFile('ibkr_oauth_private_encryption', 'IBKR_OAUTH_ENCRYPTION_PEM_PATH'),
  ]);

  const key = consumerKey.trim().toUpperCase();
  return {
    consumerKey: key,
    accessToken: accessToken.trim(),
    accessTokenSecret: accessTokenSecret.trim(),
    dhPrime: normalizeDhPrime(dhPrime),
    signature,
    encryption,
    // test_realm is only for IB's demo TESTCONS key — portal keys (e.g. AUTOTRADE) use limited_poa
    realm: key === 'TESTCONS' ? 'test_realm' : 'limited_poa',
  };
}

async function getIbkrClient() {
  if (!clientPromise) {
    clientPromise = loadOAuthConfig().then((config) => new IbkrClient(config));
  }
  return clientPromise;
}

async function ensureIbkrSession() {
  if (!initPromise) {
    initPromise = (async () => {
      const client = await getIbkrClient();
      await client.init();
    })();
  }
  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

function parsePathAndParams(fullPath) {
  const qIndex = fullPath.indexOf('?');
  if (qIndex === -1) return { path: fullPath, params: {} };

  const pathOnly = fullPath.slice(0, qIndex);
  const params = {};
  new URLSearchParams(fullPath.slice(qIndex + 1)).forEach((value, key) => {
    params[key] = value;
  });
  return { path: pathOnly, params };
}

async function ibkrApiRequest(method, fullPath, body = null) {
  await ensureIbkrSession();
  const client = await getIbkrClient();
  const { path: apiPath, params } = parsePathAndParams(fullPath);

  try {
    return await client.request({
      path: apiPath,
      method,
      data: body ?? undefined,
      params,
    });
  } catch (err) {
    if (!String(err.message).includes('401')) throw err;
    initPromise = null;
    await ensureIbkrSession();
    return client.request({
      path: apiPath,
      method,
      data: body ?? undefined,
      params,
    });
  }
}

async function pingIbkrCredentials() {
  await ibkrApiRequest('GET', '/portfolio/accounts');
  return true;
}

function resetIbkrSession() {
  clientPromise = null;
  initPromise = null;
  clearSecretCache();
}

/** Safe summary for logs / diagnostics (no secrets). */
function credentialsLookConfigured(diag) {
  if (!diag.signaturePemFingerprint || diag.dhPrimeLength < 512 || !diag.accessTokenLength) {
    return false;
  }
  if (diag.smLatestsignatureFingerprint
    && diag.signaturePemFingerprint !== diag.smLatestsignatureFingerprint) {
    return false;
  }
  if (diag.deployedsignatureFingerprint
    && diag.signaturePemFingerprint !== diag.deployedsignatureFingerprint) {
    return false;
  }
  return true;
}

async function getIbkrOAuthDiagnostics() {
  const config = await loadOAuthConfig();
  const fingerprintCompare = await getIbkrSecretFingerprints();
  const egressIp = process.env.K_SERVICE ? await fetchCloudEgressIp() : null;
  const diag = {
    consumerKey: config.consumerKey,
    realm: config.realm,
    accessTokenLength: config.accessToken.length,
    accessTokenSecretLength: config.accessTokenSecret.length,
    dhPrimeLength: config.dhPrime.length,
    signaturePemLength: config.signature?.length ?? 0,
    encryptionPemLength: config.encryption?.length ?? 0,
    signaturePemFingerprint: pemFingerprint(config.signature),
    encryptionPemFingerprint: pemFingerprint(config.encryption),
    signatureSecretSource: getSecretSource('ibkr_oauth_private_signature'),
    encryptionSecretSource: getSecretSource('ibkr_oauth_private_encryption'),
    credentialsLookValid: false,
    egressIp,
    httpProxyConfigured: Boolean(process.env.IBKR_HTTP_PROXY || process.env.IBKR_HTTPS_PROXY),
    ...fingerprintCompare,
  };
  diag.credentialsLookValid = credentialsLookConfigured(diag);
  return diag;
}

function invalidConsumerHint(diag) {
  if (diag?.credentialsLookValid) {
    const ipNote = diag.egressIp ? ` Cloud egress IP: ${diag.egressIp}.` : '';
    return 'OAuth keys and PEM fingerprints look correct.'
      + ' IBKR often returns "invalid consumer" for requests from Google Cloud datacenter IPs'
      + ' even when the same credentials work locally (node scripts/verify-ibkr-oauth.js).'
      + `${ipNote} Contact IBKR support to allowlist your consumer AUTOTRADE for that IP,`
      + ' or set IBKR_HTTP_PROXY on Cloud Functions to route through a network IBKR accepts.'
      + ' Also re-generate portal tokens after any PEM/DH change and wait for the weekend reset if the key is new.';
  }
  return 'Portal consumer key must match .env (e.g. AUTOTRADE), use limited_poa realm,'
    + ' tokens from Generate Token after Save Key, and run ./scripts/sync-secrets-from-env.sh --only ibkr.';
}

module.exports = {
  ibkrApiRequest,
  pingIbkrCredentials,
  resetIbkrSession,
  ensureIbkrSession,
  loadOAuthConfig,
  getIbkrOAuthDiagnostics,
  invalidConsumerHint,
};
