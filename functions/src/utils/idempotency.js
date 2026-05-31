const { getDb, FieldValue } = require('./db');

async function checkIdempotencyKey(key) {
  const doc = await getDb().doc(`idempotencyKeys/${key}`).get();
  return doc.exists;
}

async function writeIdempotencyKey(key, data, ttlSeconds = 86400) {
  const expireAt = new Date(Date.now() + ttlSeconds * 1000);
  await getDb().doc(`idempotencyKeys/${key}`).set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    expireAt,
  });
}

async function updateIdempotencyKey(key, updates) {
  await getDb().doc(`idempotencyKeys/${key}`).update(updates);
}

module.exports = {
  checkIdempotencyKey,
  writeIdempotencyKey,
  updateIdempotencyKey,
};
