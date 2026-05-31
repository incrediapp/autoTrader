# Broker Integration Spec
## Version: Production-Ready Spec v2

---

## Architecture: Unified Broker Adapter

Both brokers expose identical interfaces. The trade loop calls the adapter without
knowing which broker it's talking to. This isolates broker-specific complexity and
makes adding a third broker straightforward.

```javascript
// The interface every broker adapter must implement
class BrokerAdapter {
  async ping()                          // → boolean (connection alive?)
  async fetchPortfolio()                // → PortfolioSnapshot
  async fetchOHLCV(symbol, interval, limit) // → Candle[]
  async getSpotPrice(symbol)            // → number
  async placeOrder({ symbol, side, notionalUsd, quantity? }) // → OrderResult
  async cancelOrder(orderId)            // → void
  async getOrderStatus(orderId)         // → OrderStatus
  async getAllPositions()               // → Position[]
}

// Factory
function getBrokerAdapter(broker, userId, isPaper) {
  if (broker === 'binance') return new BinanceAdapter(userId, isPaper);
  if (broker === 'ibkr')    return new IBKRAdapter(userId, isPaper);
  throw new Error(`Unknown broker: ${broker}`);
}
```

---

## Secret Management

All API keys are stored in Google Cloud Secret Manager. Never in Firestore.
Never in Cloud Function environment variables (those appear in GCP logs).

```javascript
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const secretClient = new SecretManagerServiceClient();

// Cache secrets in memory for the Cloud Function instance lifetime
// (instances are reused across invocations — saves Secret Manager API calls)
const secretCache = new Map();

async function getSecret(name) {
  if (secretCache.has(name)) return secretCache.get(name);

  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${process.env.GCLOUD_PROJECT}/secrets/${name}/versions/latest`
  });
  const value = version.payload.data.toString('utf8').trim();
  secretCache.set(name, value);
  return value;
}

// Secret naming convention
// binance_apikey_{userId}      → user's Binance API key
// binance_apisecret_{userId}   → user's Binance API secret
// ibkr_accesstoken_{userId}    → IBKR OAuth access token
// ibkr_refreshtoken_{userId}   → IBKR OAuth refresh token
// ibkr_tokenexpiry_{userId}    → ISO timestamp of access token expiry
// anthropic_api_key            → single global Claude API key
// newsdata_api_key             → single global Newsdata.io key
```

---

## Binance Integration

### API Environment

```javascript
const BINANCE = {
  live:   'https://api.binance.com',
  paper:  'https://testnet.binance.vision',  // full-featured testnet, different keys
  wsLive: 'wss://stream.binance.com:9443',
  wsPaper:'wss://testnet.binance.vision'
};
```

**Important:** The Binance testnet requires separate API keys (not the same as live).
Users must generate testnet keys at https://testnet.binance.vision and connect them
separately. The app shows two "Connect" options within Binance: Live and Testnet.

### Authentication — HMAC-SHA256

```javascript
const crypto = require('crypto');

function createSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binanceRequest(method, path, params = {}, userId, isPaper = false) {
  const creds = await getBinanceCredentials(userId, isPaper);
  const baseUrl = isPaper ? BINANCE.paper : BINANCE.live;
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryString = new URLSearchParams(allParams).toString();
  const signature = createSignature(queryString, creds.apiSecret);
  const url = `${baseUrl}${path}?${queryString}&signature=${signature}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);  // 10s timeout

  try {
    const response = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: controller.signal
    });
    clearTimeout(timeout);

    // Binance returns 200 even for some errors — check response body
    const data = await response.json();

    if (!response.ok || data.code < 0) {
      const err = new Error(data.msg || `Binance HTTP ${response.status}`);
      err.code = data.code;
      err.httpStatus = response.status;
      throw err;
    }

    return data;

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Binance API timeout (10s)');
    throw err;
  }
}
```

### Endpoints

#### GET /api/v3/ping — Connection test

```javascript
async ping(userId, isPaper) {
  try {
    await fetch(`${isPaper ? BINANCE.paper : BINANCE.live}/api/v3/ping`);
    return true;
  } catch {
    return false;
  }
}
```

#### GET /api/v3/klines — OHLCV data

Public endpoint — no auth required. Shared cache reduces redundant calls.

```javascript
async fetchBinanceOHLCV(symbol, interval = '15m', limit = 200) {
  const url = `${BINANCE.live}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Klines fetch failed: ${response.status}`);
  const data = await response.json();

  return data.map(c => ({
    t: c[0],              // open time (ms)
    o: parseFloat(c[1]),  // open
    h: parseFloat(c[2]),  // high
    l: parseFloat(c[3]),  // low
    c: parseFloat(c[4]),  // close
    v: parseFloat(c[5]),  // volume
  }));
}
```

#### GET /api/v3/ticker/price — Spot price

```javascript
async getSpotPrice(symbol, userId, isPaper) {
  const baseUrl = isPaper ? BINANCE.paper : BINANCE.live;
  const resp = await fetch(`${baseUrl}/api/v3/ticker/price?symbol=${symbol}`,
    { signal: AbortSignal.timeout(5_000) });
  const data = await resp.json();
  return parseFloat(data.price);
}
```

#### GET /api/v3/account — Portfolio

```javascript
async fetchBinancePortfolio(userId, isPaper) {
  const data = await binanceRequest('GET', '/api/v3/account', {}, userId, isPaper);

  // Get all non-zero balances
  const nonZero = data.balances.filter(
    b => parseFloat(b.free) > 0.000001 || parseFloat(b.locked) > 0.000001
  );

  // Separate cash (USDT, BUSD, USDC) from positions
  const stablecoins = ['USDT', 'BUSD', 'USDC', 'FDUSD'];
  const cashUsd = nonZero
    .filter(b => stablecoins.includes(b.asset))
    .reduce((sum, b) => sum + parseFloat(b.free) + parseFloat(b.locked), 0);

  const positions = nonZero
    .filter(b => !stablecoins.includes(b.asset))
    .map(b => ({
      symbol: `${b.asset}USDT`,  // canonical pair
      asset: b.asset,
      quantity: parseFloat(b.free) + parseFloat(b.locked),
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
    }));

  // Enrich with current prices to get USD values
  const prices = await Promise.all(
    positions.map(p => getSpotPrice(p.symbol, userId, isPaper))
  );

  const enrichedPositions = positions.map((p, i) => ({
    ...p,
    currentPriceUsd: prices[i],
    currentValueUsd: p.quantity * prices[i],
  }));

  const totalValueUsd = cashUsd + enrichedPositions.reduce((sum, p) => sum + p.currentValueUsd, 0);

  return { cashUsd, totalValueUsd, positions: enrichedPositions };
}
```

#### POST /api/v3/order — Place order

```javascript
async placeBinanceOrder({ symbol, side, notionalUsd, quantity }, userId, isPaper) {
  const params = {
    symbol: toBinanceSymbol(symbol),
    side: side.toUpperCase(),
    type: 'MARKET',
    newOrderRespType: 'FULL',   // get fill details immediately
  };

  if (side === 'buy') {
    // Buy by quote amount (USD)
    params.quoteOrderQty = notionalUsd.toFixed(2);
  } else {
    // Sell by base quantity — must be precise
    if (!quantity) throw new Error('Sell order requires quantity');
    params.quantity = formatBinanceQuantity(symbol, quantity);
  }

  const result = await binanceRequest('POST', '/api/v3/order', params, userId, isPaper);

  const fills = result.fills ?? [];
  const totalFee = fills.reduce((sum, f) => {
    // Convert BNB fees to USD equivalent (approximation)
    const feeInUsd = f.commissionAsset === 'BNB'
      ? parseFloat(f.commission) * (await getBNBPrice())
      : parseFloat(f.commission);
    return sum + feeInUsd;
  }, 0);

  const executedQty = parseFloat(result.executedQty);
  const executedNotional = parseFloat(result.cummulativeQuoteQty);
  const avgPrice = executedQty > 0 ? executedNotional / executedQty : 0;

  return {
    orderId: result.orderId.toString(),
    status: result.status,           // 'FILLED', 'PARTIALLY_FILLED', 'REJECTED'
    executedQty,
    executedPrice: avgPrice,
    executedNotionalUsd: executedNotional,
    feeUsd: totalFee,
    feeCurrency: 'USD',
    feeAsset: fills[0]?.commissionAsset ?? 'USDT',
    raw: result
  };
}

// Format quantity to Binance's required precision for each symbol
// (LOT_SIZE filter from exchange info — cache this per symbol)
function formatBinanceQuantity(symbol, quantity) {
  const stepSize = getBinanceStepSize(symbol);  // from cached exchangeInfo
  const precision = Math.max(0, -Math.log10(stepSize));
  return quantity.toFixed(precision);
}
```

#### Exchange Info Cache (for LOT_SIZE filters)

```javascript
// Cache Binance exchange info (filter rules per symbol)
// Refreshed daily — rarely changes
async function getBinanceExchangeInfo() {
  const cacheKey = 'binanceExchangeInfo';
  const cached = await getFromFirestore(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) {
    return cached.data;
  }
  const resp = await fetch(`${BINANCE.live}/api/v3/exchangeInfo`);
  const data = await resp.json();
  await saveToFirestore(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}
```

### Binance Rate Limits

| Type | Limit | Our usage |
|---|---|---|
| Request weight / minute | 6,000 | ~200 per 15-min cycle |
| Orders / 10 seconds | 50 | At most 20 per cycle |
| Orders / day | 160,000 | ~100/day even at scale |
| Raw requests / 5 min | 61,000 | Well within |

Implement `Retry-After` header parsing on 429 responses:

```javascript
if (response.status === 429) {
  const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60');
  logger.warn(`Binance rate limited. Waiting ${retryAfter}s.`);
  await sleep(retryAfter * 1000);
  // Then retry once
}

// Binance 418 = IP banned for repeated rate limit violations
if (response.status === 418) {
  await logError({ source: 'broker_binance', severity: 'critical',
    message: 'Binance IP ban (418) — reduce request rate immediately' });
  throw new Error('Binance IP ban active');
}
```

### Binance Error Codes

| Code | Message | Action |
|---|---|---|
| -1000 | Unknown | Log, skip cycle |
| -1003 | Too many requests | Backoff 60s, retry |
| -1013 | Filter failure (min notional) | Log as warning, skip trade |
| -1021 | Timestamp outside recvWindow | Sync server time, retry |
| -1100 | Illegal characters in parameter | Log error (bug in our code) |
| -1121 | Invalid symbol | Log error, check symbol mapping |
| -2010 | Insufficient balance | Log warning, skip trade, notify user |
| -2011 | Unknown order | Log, mark order as unknown |
| -2015 | Invalid API key | Log critical, notify user to reconnect |

---

## Interactive Brokers Integration

### API: IBKR Client Portal Web API

Use IBKR's REST-based Client Portal Web API (not the legacy TWS socket API).
The Client Portal API is cloud-compatible and works from Cloud Functions.

**Base URL:** `https://api.ibkr.com/v1/api`

### Authentication: OAuth 2.0

IBKR uses a two-step OAuth flow. The user authenticates once in the Flutter app
via a WebView, and the resulting tokens are stored in Secret Manager.

```
Step 1: Flutter opens IBKR OAuth URL in WebView or browser
  https://www.interactivebrokers.com/oauth2/auth
    ?client_id=YOUR_IBKR_CLIENT_ID
    &redirect_uri=https://your-app.com/ibkr-callback
    &response_type=code
    &scope=trading%20read

Step 2: IBKR redirects to redirect_uri with ?code=AUTH_CODE

Step 3: Flutter captures code, calls Cloud Function `connectIBKR`

Step 4: Cloud Function POSTs to IBKR token endpoint:
  POST https://www.interactivebrokers.com/oauth2/token
  Body: {
    grant_type: 'authorization_code',
    code: AUTH_CODE,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  }

Step 5: Response: { access_token, refresh_token, expires_in, token_type }

Step 6: Store tokens in Secret Manager.
        Store expiry timestamp in Firestore (users/{uid}.brokers.ibkr.tokenExpiresAt)
        so the Flutter UI can show a warning before expiry.
```

### Token Refresh

```javascript
async function getValidIBKRToken(userId) {
  // Check expiry from Firestore (fast, no Secret Manager call)
  const userDoc = await db.doc(`users/${userId}`).get();
  const tokenExpiresAt = userDoc.data().brokers?.ibkr?.tokenExpiresAt?.toDate();

  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (!tokenExpiresAt || tokenExpiresAt < fiveMinutesFromNow) {
    // Token expired or expiring soon — refresh
    return await refreshIBKRToken(userId);
  }

  return await getSecret(`ibkr_accesstoken_${userId}`);
}

async function refreshIBKRToken(userId) {
  const refreshToken = await getSecret(`ibkr_refreshtoken_${userId}`);

  const response = await fetch('https://www.interactivebrokers.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: await getSecret('ibkr_client_id'),
      client_secret: await getSecret('ibkr_client_secret'),
    })
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 400 || response.status === 401) {
      // Refresh token also expired — user must re-authenticate
      await db.doc(`users/${userId}`).update({
        'brokers.ibkr.connected': false,
        'brokers.ibkr.lastErrorAt': FieldValue.serverTimestamp(),
        'brokers.ibkr.lastErrorMessage': 'Session expired — please reconnect IBKR'
      });
      // Auto-pause all IBKR strategies
      await autoPauseIBKRStrategies(userId, 'ibkr_auth_expired');
      // Notify user
      await sendNotification(userId, 'ibkr_session_expired', null, {});
      throw new Error('IBKR refresh token expired — user must re-authenticate');
    }
    throw new Error(`IBKR token refresh failed: ${response.status} ${body}`);
  }

  const tokens = await response.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Store new tokens
  await Promise.all([
    storeSecret(`ibkr_accesstoken_${userId}`, tokens.access_token),
    storeSecret(`ibkr_refreshtoken_${userId}`, tokens.refresh_token),
    storeSecret(`ibkr_tokenexpiry_${userId}`, expiresAt.toISOString()),
  ]);

  // Update Firestore expiry for UI warning
  await db.doc(`users/${userId}`).update({
    'brokers.ibkr.tokenExpiresAt': Timestamp.fromDate(expiresAt),
    'brokers.ibkr.lastVerifiedAt': FieldValue.serverTimestamp(),
  });

  // Alert user 2 hours before expiry (send FCM)
  const twoHoursFromExpiry = new Date(expiresAt.getTime() - 2 * 60 * 60 * 1000);
  await scheduleNotification(userId, 'ibkr_auth_expiring', twoHoursFromExpiry);

  return tokens.access_token;
}
```

### IBKR API Wrapper

```javascript
async function ibkrRequest(method, path, userId, body = null) {
  const token = await getValidIBKRToken(userId);
  const url = `https://api.ibkr.com/v1/api${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.status === 401) {
      // Token rejected — try refresh once then retry
      const newToken = await refreshIBKRToken(userId);
      const retry = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${newToken}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!retry.ok) throw new Error(`IBKR ${retry.status} after token refresh`);
      return retry.json();
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`IBKR API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('IBKR API timeout (15s)');
    throw err;
  }
}
```

### Contract ID (conid) Resolution

IBKR uses numeric contract IDs, not ticker symbols. We cache these in Firestore.

```javascript
async function resolveConid(symbol) {
  // Check cache first
  const cached = await db.doc(`ibkrConidCache/${symbol}`).get();
  if (cached.exists) return cached.data().conid;

  // Search for the contract
  const results = await ibkrRequest('GET',
    `/iserver/secdef/search?symbol=${symbol}&secType=STK`);

  if (!results || results.length === 0) {
    throw new Error(`IBKR: No contract found for symbol ${symbol}`);
  }

  // Prefer US exchange, USD currency
  const contract = results.find(r => r.currency === 'USD') ?? results[0];

  // Cache it
  await db.doc(`ibkrConidCache/${symbol}`).set({
    symbol, conid: contract.conid,
    exchange: contract.exchange,
    currency: contract.currency,
    secType: contract.secType,
    cachedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)  // 7 day TTL
  });

  return contract.conid;
}
```

### Endpoints Used

#### Portfolio positions

```javascript
async fetchIBKRPortfolio(userId) {
  const accountId = await getIBKRAccountId(userId);
  const positions = await ibkrRequest('GET', `/portfolio/${accountId}/positions/0`, userId);
  const summary   = await ibkrRequest('GET', `/portfolio/${accountId}/summary`, userId);

  const cashUsd = summary.availablefunds?.amount ?? 0;

  const mappedPositions = (positions ?? []).map(p => ({
    symbol: p.ticker,
    conid: p.conid,
    quantity: p.position,
    avgCostUsd: p.avgCost,
    currentPriceUsd: p.mktPrice,
    currentValueUsd: p.mktValue,
    unrealizedPnlUsd: p.unrealizedPnl,
    unrealizedPnlPct: p.unrealizedPnlPercent,
  }));

  const totalValueUsd = cashUsd + mappedPositions.reduce((sum, p) => sum + p.currentValueUsd, 0);

  return { cashUsd, totalValueUsd, positions: mappedPositions };
}
```

#### Historical OHLCV

```javascript
async fetchIBKROHLCV(symbol, userId) {
  const conid = await resolveConid(symbol);

  // Request 2 days of 15-min bars to ensure we get 200 candles
  const data = await ibkrRequest('GET',
    `/iserver/marketdata/history?conid=${conid}&period=2d&bar=15min&outsideRth=false`,
    userId);

  if (!data?.data?.length) {
    throw new Error(`IBKR: No historical data for ${symbol}`);
  }

  return data.data.map(c => ({
    t: c.t * 1000,   // IBKR returns seconds, convert to ms
    o: c.o,
    h: c.h,
    l: c.l,
    c: c.c,
    v: c.v,
  }));
}
```

#### Place Order (with confirmation handling)

IBKR's order placement is a two-step process — it may return a `messageIds` array
requiring a second call to confirm. This is normal for market orders.

```javascript
async placeIBKROrder({ symbol, side, notionalUsd, quantity }, userId) {
  const accountId = await getIBKRAccountId(userId);
  const conid = await resolveConid(symbol);

  // Calculate quantity from notional if not provided
  if (!quantity) {
    const price = await getIBKRSpotPrice(conid, userId);
    quantity = Math.floor((notionalUsd / price) * 100) / 100;  // 2 decimal places
    if (quantity <= 0) throw new Error(`Calculated quantity too small: ${quantity}`);
  }

  const orderBody = {
    orders: [{
      conid,
      orderType: 'MKT',
      side: side.toUpperCase(),
      quantity,
      tif: 'DAY',
      outsideRth: false,
    }]
  };

  let result = await ibkrRequest('POST',
    `/iserver/account/${accountId}/orders`, userId, orderBody);

  // Handle IBKR's confirmation requirement
  // Result may be [{ id, message }] (needs confirm) or [{ order_id, order_status }] (placed)
  if (result[0]?.id && result[0]?.message) {
    // Confirmation required
    const confirmBody = { confirmed: true };
    result = await ibkrRequest('POST',
      `/iserver/reply/${result[0].id}`, userId, confirmBody);
  }

  const order = result[0];
  if (!order?.order_id) {
    throw new Error(`IBKR order placement failed: ${JSON.stringify(result)}`);
  }

  return {
    orderId: order.order_id.toString(),
    status: order.order_status === 'Filled' ? 'filled' : 'pending_fill',
    executedQty: order.order_status === 'Filled' ? order.filledQuantity : quantity,
    executedPrice: order.avgPrice ?? 0,    // may be 0 if not yet filled
    executedNotionalUsd: (order.avgPrice ?? 0) * quantity,
    feeUsd: 0,       // IBKR commission computed asynchronously, updated by fill poller
    feeCurrency: 'USD',
    feeAsset: null,
    raw: order
  };
}
```

#### Get Order Status (used by fill poller)

```javascript
async getIBKROrderStatus(userId, orderId) {
  const accountId = await getIBKRAccountId(userId);
  const data = await ibkrRequest('GET',
    `/iserver/account/${accountId}/order/status/${orderId}`, userId);

  return {
    status: data.status,               // 'Filled', 'Submitted', 'Cancelled', etc.
    filledQuantity: data.filled ?? 0,
    remainingQuantity: data.remaining ?? 0,
    avgPrice: data.avgPrice ?? 0,
    commission: data.commission ?? 0,
    lastFillTime: data.lastFillTime ?? null
  };
}
```

### IBKR Market Hours Check

```javascript
const IBKR_MARKET_SESSIONS = {
  'XNYS': {  // NYSE
    timezone: 'America/New_York',
    open: '09:30', close: '16:00',
    daysOfWeek: [1, 2, 3, 4, 5]  // Mon-Fri
  },
  'NASDAQ': {
    timezone: 'America/New_York',
    open: '09:30', close: '16:00',
    daysOfWeek: [1, 2, 3, 4, 5]
  }
};

function isMarketOpen(exchange = 'XNYS') {
  const session = IBKR_MARKET_SESSIONS[exchange];
  const now = new Date();
  const nyTime = new Intl.DateTimeFormat('en-US', {
    timeZone: session.timezone,
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short'
  }).formatToParts(now);

  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
    nyTime.find(p => p.type === 'weekday').value
  );
  const time = `${nyTime.find(p => p.type === 'hour').value}:${nyTime.find(p => p.type === 'minute').value}`;

  return session.daysOfWeek.includes(day) && time >= session.open && time < session.close;
}
```

---

## External Data APIs

### Fear & Greed Index

```javascript
async function fetchFearGreedCached() {
  const cacheRef = db.doc('externalDataCache/fearGreed');
  const cached = await cacheRef.get();

  if (cached.exists) {
    const data = cached.data();
    const ageMs = Date.now() - data.fetchedAt.toMillis();
    if (ageMs < 60 * 60 * 1000) return data;  // < 1 hour old
  }

  const response = await fetch('https://api.alternative.me/fng/?limit=1',
    { signal: AbortSignal.timeout(5_000) });

  if (!response.ok) throw new Error(`Fear & Greed API failed: ${response.status}`);

  const json = await response.json();
  const entry = json.data[0];

  const result = {
    value: parseInt(entry.value),
    label: entry.value_classification,
    timestamp: parseInt(entry.timestamp),
    fetchedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 60 * 60 * 1000)
  };

  await cacheRef.set(result);
  return result;
}
```

### Newsdata.io

```javascript
async function fetchNewsCached(symbols) {
  // Key by sorted symbols to reuse cache across strategies with same watchlist
  const symbolKey = symbols.map(s => s.replace('USDT', '')).sort().join('_');
  const cacheRef = db.doc(`externalDataCache/news_${symbolKey}`);
  const cached = await cacheRef.get();

  if (cached.exists) {
    const ageMs = Date.now() - cached.data().fetchedAt.toMillis();
    if (ageMs < 30 * 60 * 1000) return cached.data().headlines;  // < 30 min old
  }

  // Check quota before calling
  const quota = await checkAndIncrementNewsQuota();
  if (!quota.ok) {
    logger.warn(`Newsdata.io quota exhausted: ${quota.callsToday}/${quota.quotaLimit}`);
    throw new Error('NEWS_QUOTA_EXHAUSTED');
  }

  const apiKey = await getSecret('newsdata_api_key');
  const query = symbols.map(s => s.replace('USDT', '')).join(' OR ');
  const url = `https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(query)}&language=en&size=5`;

  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });

  if (response.status === 429) throw new Error('Newsdata.io rate limited');
  if (!response.ok) throw new Error(`Newsdata.io failed: ${response.status}`);

  const data = await response.json();
  const headlines = (data.results ?? []).slice(0, 3).map(r => r.title);

  await cacheRef.set({
    headlines, symbolKey,
    fetchedAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 30 * 60 * 1000)
  });

  return headlines;
}

async function checkAndIncrementNewsQuota() {
  const quotaRef = db.doc('externalDataCache/newsdataQuota');

  return await db.runTransaction(async (tx) => {
    const doc = await tx.get(quotaRef);
    const today = new Date().toISOString().split('T')[0];
    const data = doc.data() ?? { callsToday: 0, quotaLimit: 200, dayReset: today };

    // Reset if new day
    if (data.dayReset !== today) {
      data.callsToday = 0;
      data.dayReset = today;
      data.quotaExhausted = false;
    }

    if (data.callsToday >= data.quotaLimit) {
      data.quotaExhausted = true;
      tx.set(quotaRef, data);
      return { ok: false, callsToday: data.callsToday, quotaLimit: data.quotaLimit };
    }

    data.callsToday += 1;
    data.lastCallAt = FieldValue.serverTimestamp();
    tx.set(quotaRef, data);
    return { ok: true, callsToday: data.callsToday, quotaLimit: data.quotaLimit };
  });
}
```

---

## Technical Indicators

Use the `technicalindicators` npm package for accuracy over hand-rolled code.

```javascript
const {
  RSI, MACD, EMA, BollingerBands, ATR
} = require('technicalindicators');

// All indicators called with closes array of sufficient length
// Minimum: RSI needs period+1, MACD needs slow+signal, EMA needs period

function computeAllIndicators(candles) {
  const closes = candles.map(c => c.c);
  const highs   = candles.map(c => c.h);
  const lows    = candles.map(c => c.l);

  if (closes.length < 52) {  // need 52 for EMA50 + a few extra
    throw new Error(`Insufficient candles for indicator computation: ${closes.length}`);
  }

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const macdValues = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false
  });
  const ema20Values = EMA.calculate({ values: closes, period: 20 });
  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema200Values = closes.length >= 200
    ? EMA.calculate({ values: closes, period: 200 })
    : null;
  const bbValues = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

  // Return last values only
  return {
    rsi14:         rsiValues.at(-1) ?? null,
    macdLine:      macdValues.at(-1)?.MACD ?? null,
    macdSignal:    macdValues.at(-1)?.signal ?? null,
    macdHistogram: macdValues.at(-1)?.histogram ?? null,
    ema20:         ema20Values.at(-1) ?? null,
    ema50:         ema50Values.at(-1) ?? null,
    ema200:        ema200Values?.at(-1) ?? null,
    bbUpper:       bbValues.at(-1)?.upper ?? null,
    bbMiddle:      bbValues.at(-1)?.middle ?? null,
    bbLower:       bbValues.at(-1)?.lower ?? null,
    atr14:         atrValues.at(-1) ?? null,
  };
}
```

---

## Position Management: FIFO Cost Basis

For tax accuracy, positions track lots on a FIFO basis.

```javascript
async function updatePositionAfterTrade(strategy, userId, decision, qty, price, tradeId) {
  const posRef = db.doc(
    `users/${userId}/strategies/${strategy.strategyId}/positions/${decision.symbol}`
  );

  await db.runTransaction(async (tx) => {
    const posDoc = await tx.get(posRef);

    if (decision.side === 'buy') {
      // Add to position
      const existing = posDoc.exists ? posDoc.data() : {
        symbol: decision.symbol,
        quantity: 0, avgCostUsd: 0, totalCostBasisUsd: 0,
        lotsFIFO: [], openedAt: FieldValue.serverTimestamp()
      };

      const newQuantity = existing.quantity + qty;
      const newCostBasis = existing.totalCostBasisUsd + (qty * price);
      const newAvgCost = newQuantity > 0 ? newCostBasis / newQuantity : 0;

      tx.set(posRef, {
        ...existing,
        quantity: newQuantity,
        avgCostUsd: newAvgCost,
        totalCostBasisUsd: newCostBasis,
        currentPriceUsd: price,
        currentValueUsd: newQuantity * price,
        unrealizedPnlUsd: newQuantity * price - newCostBasis,
        unrealizedPnlPct: newCostBasis > 0 ? ((newQuantity * price - newCostBasis) / newCostBasis) * 100 : 0,
        lotsFIFO: [...(existing.lotsFIFO ?? []), {
          tradeId, quantity: qty, costPerUnit: price,
          acquiredAt: new Date(), remainingQty: qty
        }],
        lastUpdatedAt: FieldValue.serverTimestamp(),
        strategyId: strategy.strategyId,
        userId,
        broker: strategy.assets.broker,
      });

    } else {
      // Remove from position (FIFO)
      if (!posDoc.exists) throw new Error(`No position to sell: ${decision.symbol}`);

      const pos = posDoc.data();
      let remainingToSell = qty;
      const lots = [...pos.lotsFIFO];
      let totalCostBasisClosed = 0;

      for (const lot of lots) {
        if (remainingToSell <= 0) break;
        const closeQty = Math.min(lot.remainingQty, remainingToSell);
        lot.remainingQty -= closeQty;
        totalCostBasisClosed += closeQty * lot.costPerUnit;
        remainingToSell -= closeQty;
      }

      const newQuantity = pos.quantity - qty;
      const newCostBasis = pos.totalCostBasisUsd - totalCostBasisClosed;

      // Update trade doc with P&L and tax fields
      const tradeRef = db.doc(
        `users/${userId}/strategies/${strategy.strategyId}/trades/${tradeId}`
      );
      const proceeds = qty * price;
      const realizedPnl = proceeds - totalCostBasisClosed;

      tx.update(tradeRef, {
        isClosingTrade: true,
        costBasisUsd: totalCostBasisClosed,
        proceedsUsd: proceeds,
        netProceedsUsd: proceeds,  // fees subtracted separately
        realizedPnlUsd: realizedPnl,
        realizedPnlPct: totalCostBasisClosed > 0 ? (realizedPnl / totalCostBasisClosed) * 100 : 0,
      });

      if (newQuantity <= 0.000001) {
        // Position closed
        tx.delete(posRef);
      } else {
        const newAvgCost = newQuantity > 0 ? newCostBasis / newQuantity : 0;
        tx.update(posRef, {
          quantity: newQuantity,
          avgCostUsd: newAvgCost,
          totalCostBasisUsd: newCostBasis,
          lotsFIFO: lots.filter(l => l.remainingQty > 0.000001),
          currentPriceUsd: price,
          currentValueUsd: newQuantity * price,
          unrealizedPnlUsd: newQuantity * price - newCostBasis,
          unrealizedPnlPct: newCostBasis > 0 ? ((newQuantity * price - newCostBasis) / newCostBasis) * 100 : 0,
          lastUpdatedAt: FieldValue.serverTimestamp()
        });
      }
    }
  });
}
```
