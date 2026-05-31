const { getDb } = require('./db');

async function findStrategyById(strategyId) {
  const usersSnap = await getDb().collection('users').limit(50).get();
  for (const userDoc of usersSnap.docs) {
    const stratDoc = await getDb()
      .doc(`users/${userDoc.id}/strategies/${strategyId}`)
      .get();
    if (stratDoc.exists) {
      return stratDoc.data();
    }
  }
  return null;
}

module.exports = { findStrategyById };
