const fs = require('fs');
const path = require('path');
const { IbkrClient } = require('ibkr-client');
const { getSecret } = require('../utils/secrets');

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

  return {
    consumerKey: consumerKey.trim(),
    accessToken: accessToken.trim(),
    accessTokenSecret: accessTokenSecret.trim(),
    dhPrime: dhPrime.replace(/\s/g, ''),
    signature,
    encryption,
    realm: consumerKey.trim() === 'TESTCONS' ? 'test_realm' : 'limited_poa',
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
}

module.exports = {
  ibkrApiRequest,
  pingIbkrCredentials,
  resetIbkrSession,
  ensureIbkrSession,
};
