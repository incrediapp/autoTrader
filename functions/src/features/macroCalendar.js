const { getDb, FieldValue } = require('../utils/db');
const { getSecret } = require('../utils/secrets');
const { slugify } = require('../utils/helpers');
const { createLogContext, logInfo, logWarn } = require('../monitoring/logger');

const BATCH_SIZE = 400;

function classifyImpact(event) {
  const impactLabel = String(event.impact ?? '').toLowerCase();
  if (impactLabel === 'high') return 'high';
  if (impactLabel === 'medium') return 'medium';
  if (impactLabel === 'holiday' || impactLabel === 'low') return 'low';

  const highImpactKeywords = [
    'federal reserve', 'interest rate', 'fomc', 'cpi', 'inflation',
    'nonfarm payroll', 'gdp', 'ecb', 'bank of england', 'unemployment',
  ];
  const name = (event.event ?? event.name ?? '').toLowerCase();
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

function parseEventDate(event) {
  const rawDate = event.date ?? event.releaseDate ?? event.eventDate;
  if (!rawDate) return null;

  const timeRaw = event.time ?? event.releaseTime ?? null;
  let combined = String(rawDate).trim();

  if (timeRaw && !combined.includes('T') && !/\d{1,2}:\d{2}/.test(combined)) {
    const timePart = String(timeRaw).trim();
    const normalizedTime = /^\d{1,2}:\d{2}$/.test(timePart) ? `${timePart}:00` : timePart;
    combined = `${combined}T${normalizedTime}`;
  }

  const parsed = new Date(combined);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function normalizeFmpEvent(raw) {
  return {
    event: raw.event ?? raw.name ?? raw.title ?? 'Economic release',
    country: raw.country ?? raw.region ?? 'US',
    date: raw.date ?? raw.releaseDate,
    time: raw.time ?? raw.releaseTime ?? null,
    impact: raw.impact,
    currency: raw.currency ?? null,
    actual: raw.actual ?? null,
    estimate: raw.estimate ?? raw.forecast ?? raw.consensus ?? null,
    previous: raw.previous ?? null,
    unit: raw.unit ?? null,
  };
}

function extractEventsPayload(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.economicCalendar)) return json.economicCalendar;
  if (json?.['Error Message'] || json?.message) {
    throw new Error(json['Error Message'] ?? json.message);
  }
  return [];
}

const FOREX_FACTORY_FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
];
const FEED_CACHE_DOC = 'externalDataCache/macroCalendarFeed';
const FEED_CACHE_MS = 6 * 60 * 60 * 1000;

function normalizeForexFactoryRaw(raw) {
  return {
    event: raw.title ?? raw.event,
    country: raw.country ?? 'USD',
    date: raw.date,
    time: null,
    impact: raw.impact,
    estimate: raw.forecast || null,
    previous: raw.previous || null,
  };
}

function filterEventsByRange(events, fromDate, toDate) {
  const fromMs = fromDate.getTime();
  const toMs = toDate.getTime();
  return events.filter((event) => {
    const eventDate = parseEventDate(event);
    return eventDate && eventDate.getTime() >= fromMs && eventDate.getTime() <= toMs;
  });
}

async function readCachedForexFactoryFeed() {
  const doc = await getDb().doc(FEED_CACHE_DOC).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (!Array.isArray(data.events) || !data.events.length) return null;
  return data;
}

async function writeCachedForexFactoryFeed(events, sourceUrl) {
  await getDb().doc(FEED_CACHE_DOC).set({
    events,
    sourceUrl,
    fetchedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + FEED_CACHE_MS),
  });
}

async function downloadForexFactoryFeed() {
  let lastError = null;

  for (const url of FOREX_FACTORY_FEEDS) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoTrader/1.0)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) {
        lastError = new Error(`ForexFactory feed HTTP ${resp.status}`);
        continue;
      }
      const events = await resp.json();
      if (!Array.isArray(events) || !events.length) {
        lastError = new Error('ForexFactory feed returned no events');
        continue;
      }
      const normalized = events.map(normalizeForexFactoryRaw);
      await writeCachedForexFactoryFeed(normalized, url);
      return normalized;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('ForexFactory feed unavailable');
}

async function fetchForexFactoryCalendar(fromDate, toDate) {
  const cached = await readCachedForexFactoryFeed();
  const cacheAge = cached?.fetchedAt?.toMillis
    ? Date.now() - cached.fetchedAt.toMillis()
    : Number.POSITIVE_INFINITY;

  let events = cached?.events ?? [];

  if (cacheAge >= FEED_CACHE_MS) {
    try {
      events = await downloadForexFactoryFeed();
    } catch (err) {
      if (!events.length) throw err;
    }
  }

  const inRange = filterEventsByRange(events, fromDate, toDate);
  if (inRange.length > 0) return inRange;

  if (cacheAge < FEED_CACHE_MS) {
    try {
      events = await downloadForexFactoryFeed();
      return filterEventsByRange(events, fromDate, toDate);
    } catch (err) {
      if (events.length) return filterEventsByRange(events, fromDate, toDate);
      throw err;
    }
  }

  throw new Error('ForexFactory feed returned no events in range');
}

async function fetchFmpEconomicCalendar(apiKey, from, to) {
  const urls = [
    `https://financialmodelingprep.com/stable/economic-calendar?from=${from}&to=${to}&apikey=${apiKey}`,
    `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${apiKey}`,
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) {
        lastError = new Error(`FMP HTTP ${resp.status} for ${url}`);
        continue;
      }
      const json = await resp.json();
      const events = extractEventsPayload(json).map(normalizeFmpEvent);
      if (events.length > 0) return { events, endpoint: url.split('?')[0] };
      lastError = new Error(`FMP returned empty array from ${url}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('FMP economic calendar unavailable');
}

async function commitBatches(writes) {
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = getDb().batch();
    writes.slice(i, i + BATCH_SIZE).forEach(({ ref, data }) => batch.set(ref, data));
    await batch.commit();
  }
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
  const ctx = createLogContext('macroCalendar', null, null);

  const fromDate = new Date();
  fromDate.setHours(0, 0, 0, 0);
  const toDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().split('T')[0];
  const to = toDate.toISOString().split('T')[0];

  let events = [];
  let source = 'forexfactory';
  let endpoint = FOREX_FACTORY_FEEDS[0];

  let apiKey = null;
  try {
    apiKey = await getSecret('fmp_api_key');
  } catch {
    // FMP optional — free feed used when missing or restricted.
  }

  if (apiKey) {
    try {
      const fmp = await fetchFmpEconomicCalendar(apiKey, from, to);
      if (fmp.events.length > 0) {
        events = fmp.events;
        source = 'fmp';
        endpoint = fmp.endpoint;
      }
    } catch (err) {
      logWarn(ctx, 'FMP macro calendar unavailable, using ForexFactory feed', {
        error: err.message,
      });
    }
  }

  if (!events.length) {
    try {
      events = await fetchForexFactoryCalendar(fromDate, toDate);
      source = 'forexfactory';
      endpoint = FOREX_FACTORY_FEEDS[0];
    } catch (err) {
      logWarn(ctx, 'Macro calendar refresh failed', { error: err.message });
      return { updated: 0, highImpact: 0, skipped: true, reason: err.message };
    }
  }

  const calendarWrites = [];
  const highImpactWrites = [];
  let skippedInvalid = 0;

  for (const event of events) {
    const eventDate = parseEventDate(event);
    if (!eventDate) {
      skippedInvalid += 1;
      continue;
    }

    const impact = classifyImpact(event);
    const eventName = event.event ?? 'Economic release';
    const eventId = `${eventDate.toISOString().slice(0, 10)}_${slugify(eventName)}_${slugify(event.country ?? 'xx')}`;

    const doc = {
      eventId,
      eventName,
      shortName: abbreviateEventName(eventName),
      country: event.country ?? 'US',
      eventDate,
      eventTime: event.time ?? null,
      impact,
      currency: event.currency ?? null,
      actual: event.actual ?? null,
      forecast: event.estimate ?? null,
      previous: event.previous ?? null,
      unit: event.unit ?? null,
      source,
      fetchedAt: FieldValue.serverTimestamp(),
      expireAt: new Date(eventDate.getTime() + 7 * 24 * 60 * 60 * 1000),
    };

    calendarWrites.push({
      ref: getDb().doc(`macroCalendar/${eventId}`),
      data: doc,
    });

    const hoursUntil = (eventDate.getTime() - Date.now()) / (1000 * 60 * 60);
    if (impact === 'high' && hoursUntil >= -6 && hoursUntil <= 48) {
      highImpactWrites.push({
        ref: getDb().doc(`upcomingHighImpactEvents/${eventId}`),
        data: {
          ...doc,
          expireAt: new Date(eventDate.getTime() + 4 * 60 * 60 * 1000),
        },
      });
    }
  }

  if (calendarWrites.length > 0) await commitBatches(calendarWrites);
  if (highImpactWrites.length > 0) await commitBatches(highImpactWrites);

  logInfo(ctx, 'Macro calendar refreshed', {
    source,
    endpoint,
    updated: calendarWrites.length,
    highImpact: highImpactWrites.length,
    skippedInvalid,
  });

  return {
    updated: calendarWrites.length,
    highImpact: highImpactWrites.length,
    skippedInvalid,
    source,
    endpoint,
  };
}

module.exports = {
  getUpcomingMacroEvents,
  refreshMacroCalendarData,
  classifyImpact,
  abbreviateEventName,
  fetchFmpEconomicCalendar,
  fetchForexFactoryCalendar,
  parseEventDate,
};
