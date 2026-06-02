#!/usr/bin/env node
/**
 * Upload a file to Secret Manager without trimming (Firebase CLI trims PEM files).
 * Usage: GCLOUD_PROJECT=ai-auto-trader-a15c0 node scripts/upload-secret-raw.js SECRET_ID path/to/file
 */
const fs = require('fs');
const path = require('path');
const { SecretManagerServiceClient } = require(
  path.join(__dirname, '../functions/node_modules/@google-cloud/secret-manager'),
);

async function main() {
  const [secretId, filePath] = process.argv.slice(2);
  if (!secretId || !filePath) {
    console.error('Usage: node scripts/upload-secret-raw.js SECRET_ID path/to/file');
    process.exit(1);
  }

  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'ai-auto-trader-a15c0';
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', filePath);
  const data = fs.readFileSync(resolved);

  const client = new SecretManagerServiceClient();
  const parent = `projects/${project}/secrets/${secretId}`;

  try {
    await client.createSecret({
      parent: `projects/${project}`,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  } catch (err) {
    if (err.code !== 6) throw err;
  }

  const [version] = await client.addSecretVersion({
    parent,
    payload: { data },
  });

  const crypto = require('crypto');
  const fp = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
  console.log(`Uploaded ${secretId}: ${data.length} bytes, sha256[0:12]=${fp}`);
  console.log(version.name);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
