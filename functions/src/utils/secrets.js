const crypto = require('crypto');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const secretClient = new SecretManagerServiceClient();
const secretCache = new Map();
/** @type {Map<string, 'env'|'secret_manager'|'env_fallback'>} */
const secretSourceById = new Map();

function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-ai-trader';
}

function secretId(name) {
  return name.toUpperCase().replace(/-/g, '_');
}

/** Cloud Functions gen2 (Cloud Run). */
function isCloudRuntime() {
  return Boolean(process.env.K_SERVICE);
}

function pemFingerprint(pem) {
  if (!pem) return null;
  return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 12);
}

/**
 * PEM must keep exact bytes (incl. trailing newline).
 * Firebase CLI trims PEM on upload — we store `b64:` + base64 in Secret Manager.
 */
function normalizeSecretValue(id, raw) {
  const text = raw.toString('utf8');
  if (text.startsWith('b64:')) {
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  }
  if (text.includes('-----BEGIN')) {
    return text;
  }
  return text.trim();
}

async function fetchSecretLatest(id) {
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${getProjectId()}/secrets/${id}/versions/latest`,
  });
  return normalizeSecretValue(id, version.payload.data);
}

async function getSecret(name) {
  const id = secretId(name);
  if (secretCache.has(id)) {
    return secretCache.get(id);
  }

  const useEnvFirst =
    process.env.FUNCTIONS_EMULATOR === 'true' ||
    process.env.NODE_ENV === 'test' ||
    (!isCloudRuntime() && process.env[id]);

  if (useEnvFirst) {
    const value = normalizeSecretValue(id, process.env[id]);
    secretCache.set(id, value);
    secretSourceById.set(id, 'env');
    return value;
  }

  try {
    const value = await fetchSecretLatest(id);
    secretCache.set(id, value);
    secretSourceById.set(id, 'secret_manager');
    return value;
  } catch (err) {
    if (!isCloudRuntime() && process.env[id]) {
      const value = normalizeSecretValue(id, process.env[id]);
      secretCache.set(id, value);
      secretSourceById.set(id, 'env_fallback');
      return value;
    }
    throw new Error(`Secret unavailable: ${id} (${err.message})`);
  }
}

function getSecretSource(name) {
  return secretSourceById.get(secretId(name)) || null;
}

/** Compare deploy-pinned env vs Secret Manager latest (diagnostics only). */
async function getIbkrSecretFingerprints() {
  const ids = [
    'IBKR_OAUTH_PRIVATE_SIGNATURE',
    'IBKR_OAUTH_PRIVATE_ENCRYPTION',
  ];
  const out = {};
  for (const id of ids) {
    const short = id.replace('IBKR_OAUTH_PRIVATE_', '').toLowerCase();
    if (process.env[id]) {
      out[`deployed${short}Fingerprint`] = pemFingerprint(
        normalizeSecretValue(id, process.env[id]),
      );
    }
    try {
      const latest = await fetchSecretLatest(id);
      out[`smLatest${short}Fingerprint`] = pemFingerprint(latest);
    } catch (err) {
      out[`smLatest${short}Error`] = err.message;
    }
  }
  return out;
}

async function storeSecret(name, value) {
  const projectId = getProjectId();
  const parent = `projects/${projectId}`;
  const id = secretId(name);

  try {
    await secretClient.createSecret({
      parent,
      secretId: id,
      secret: { replication: { automatic: {} } },
    });
  } catch (err) {
    if (err.code !== 6) throw err;
  }

  await secretClient.addSecretVersion({
    parent: `${parent}/secrets/${id}`,
    payload: { data: Buffer.from(value, 'utf8') },
  });

  secretCache.set(id, value);
  secretSourceById.set(id, 'secret_manager');
}

async function deleteSecret(name) {
  const id = secretId(name);
  try {
    await secretClient.deleteSecret({
      name: `projects/${getProjectId()}/secrets/${id}`,
    });
  } catch (err) {
    if (err.code !== 5) throw err;
  }
  secretCache.delete(id);
  secretSourceById.delete(id);
}

function clearSecretCache() {
  secretCache.clear();
  secretSourceById.clear();
}

module.exports = {
  getSecret,
  getSecretSource,
  fetchSecretLatest,
  getIbkrSecretFingerprints,
  pemFingerprint,
  storeSecret,
  deleteSecret,
  clearSecretCache,
  getProjectId,
  isCloudRuntime,
};
