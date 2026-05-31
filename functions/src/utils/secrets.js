const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const secretClient = new SecretManagerServiceClient();
const secretCache = new Map();

function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-ai-trader';
}

function secretId(name) {
  return name.toUpperCase().replace(/-/g, '_');
}

async function getSecret(name) {
  const id = secretId(name);
  if (secretCache.has(id)) {
    return secretCache.get(id);
  }

  if (process.env[id]) {
    const value = process.env[id].trim();
    secretCache.set(id, value);
    return value;
  }

  try {
    const [version] = await secretClient.accessSecretVersion({
      name: `projects/${getProjectId()}/secrets/${id}/versions/latest`,
    });
    const value = version.payload.data.toString('utf8').trim();
    secretCache.set(id, value);
    return value;
  } catch (err) {
    if (process.env.FUNCTIONS_EMULATOR || process.env.NODE_ENV === 'test') {
      const envKey = id;
      const fallback = process.env[envKey];
      if (fallback) {
        secretCache.set(id, fallback);
        return fallback;
      }
    }
    throw new Error(`Secret unavailable: ${id} (${err.message})`);
  }
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
}

function clearSecretCache() {
  secretCache.clear();
}

module.exports = {
  getSecret,
  storeSecret,
  deleteSecret,
  clearSecretCache,
  getProjectId,
};
