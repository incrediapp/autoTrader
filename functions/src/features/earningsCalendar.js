const { getDb, FieldValue } = require('../utils/db');
const { getSecret } = require('../utils/secrets');

async function getEarningsContext(symbol, daysAhead = 14) {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const events = await getDb().collection('earningsCalendar')
    .where('symbol', '==', symbol)
    .where('earningsDate', '>=', now)
    .where('earningsDate', '<=', future)
    .orderBy('earningsDate')
    .limit(1)
    .get();

  if (events.empty) return null;

  const event = events.docs[0].data();
  const earningsDate = event.earningsDate?.toDate?.() ?? new Date(event.earningsDate);
  const daysUntil = Math.ceil((earningsDate - now) / (24 * 60 * 60 * 1000));

  return {
    earningsDate: event.earningsDate,
    daysUntil,
    reportTime: event.reportTime,
    fiscalQuarter: event.fiscalQuarter,
    warningLevel: daysUntil <= 2 ? 'critical' : daysUntil <= 7 ? 'warning' : 'info',
  };
}

async function refreshEarningsCalendarData() {
  const strategies = await getDb().collectionGroup('strategies')
    .where('status', '==', 'active')
    .where('assets.broker', '==', 'ibkr')
    .get();

  const symbols = new Set();
  strategies.docs.forEach((d) => {
    (d.data().assets?.watchlist ?? []).forEach((s) => symbols.add(s));
  });

  if (symbols.size === 0) return { updated: 0 };

  let apiKey;
  try {
    apiKey = await getSecret('fmp_api_key');
  } catch {
    return { updated: 0, skipped: true, reason: 'no_api_key' };
  }

  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${apiKey}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`FMP earnings API failed: ${resp.status}`);

  const events = await resp.json();
  const batch = getDb().batch();
  let count = 0;

  for (const event of events) {
    if (!symbols.has(event.symbol)) continue;
    const docId = `${event.symbol}_${event.date}`;
    batch.set(getDb().doc(`earningsCalendar/${docId}`), {
      symbol: event.symbol,
      earningsDate: new Date(event.date),
      fiscalQuarter: event.fiscalDateEnding ?? null,
      estimatedEPS: event.epsEstimated ?? null,
      actualEPS: event.eps ?? null,
      reportTime: event.time ?? null,
      source: 'fmp',
      fetchedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(new Date(event.date).getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    count++;
  }

  if (count > 0) await batch.commit();
  return { updated: count };
}

module.exports = {
  getEarningsContext,
  refreshEarningsCalendarData,
};
