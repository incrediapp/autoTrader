const { getDb, FieldValue } = require('../utils/db');
const { getSecret } = require('../utils/secrets');
const { slugify } = require('../utils/helpers');

function classifyImpact(event) {
  const highImpactKeywords = [
    'federal reserve', 'interest rate', 'fomc', 'cpi', 'inflation',
    'nonfarm payroll', 'gdp', 'ecb', 'bank of england', 'unemployment',
  ];
  const name = (event.event ?? '').toLowerCase();
  if (highImpactKeywords.some((k) => name.includes(k))) return 'high';
  if (event.impact === 'High' || event.impact === '3') return 'high';
  if (event.impact === 'Medium' || event.impact === '2') return 'medium';
  return 'low';
}

function abbreviateEventName(name) {
  const abbrevs = {
    'Federal Reserve': 'Fed Rate Decision',
    'Non Farm Payrolls': 'NFP',
    'Consumer Price Index': 'CPI',
  };
  for (const [k, v] of Object.entries(abbrevs)) {
    if (name.includes(k)) return v;
  }
  return name.length > 40 ? `${name.slice(0, 37)}…` : name;
}

async function getUpcomingMacroEvents(hoursAhead = 24) {
  const cutoff = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  const events = await getDb().collection('upcomingHighImpactEvents')
    .where('eventDate', '<=', cutoff)
    .where('eventDate', '>=', new Date())
    .orderBy('eventDate')
    .get();

  return events.docs.map((d) => d.data());
}

async function refreshMacroCalendarData() {
  let apiKey;
  try {
    apiKey = await getSecret('fmp_api_key');
  } catch {
    return { updated: 0, skipped: true, reason: 'no_api_key' };
  }

  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${apiKey}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`FMP macro API failed: ${resp.status}`);

  const events = await resp.json();
  const batch = getDb().batch();
  const highImpactBatch = getDb().batch();
  let count = 0;
  let highCount = 0;

  for (const event of events) {
    const impact = classifyImpact(event);
    const eventDate = new Date(event.date);
    const eventId = `${event.date}_${slugify(event.event)}`;

    const doc = {
      eventId,
      eventName: event.event,
      shortName: abbreviateEventName(event.event),
      country: event.country,
      eventDate,
      eventTime: event.time ?? null,
      impact,
      currency: event.currency ?? null,
      actual: event.actual ?? null,
      forecast: event.estimate ?? null,
      previous: event.previous ?? null,
      unit: event.unit ?? null,
      source: 'fmp',
      fetchedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(eventDate.getTime() + 7 * 24 * 60 * 60 * 1000),
    };

    batch.set(getDb().doc(`macroCalendar/${eventId}`), doc);
    count++;

    const hoursUntil = (eventDate - Date.now()) / (1000 * 60 * 60);
    if (impact === 'high' && hoursUntil >= 0 && hoursUntil <= 48) {
      highImpactBatch.set(getDb().doc(`upcomingHighImpactEvents/${eventId}`), {
        ...doc,
        expireAt: new Date(eventDate.getTime() + 4 * 60 * 60 * 1000),
      });
      highCount++;
    }
  }

  if (count > 0) await batch.commit();
  if (highCount > 0) await highImpactBatch.commit();

  return { updated: count, highImpact: highCount };
}

module.exports = {
  getUpcomingMacroEvents,
  refreshMacroCalendarData,
  classifyImpact,
  abbreviateEventName,
};
