/** Normalize watchlist entries to broker-native trading symbols. */

const BINANCE_USDT_BASES = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK',
  'MATIC', 'LTC', 'BCH', 'ATOM', 'UNI', 'XLM', 'ETC', 'FIL', 'APT', 'ARB',
]);

/** Non-crypto tickers / aliases → Binance USDT pair. */
const BINANCE_SYMBOL_ALIASES = {
  BITCOIN: 'BTCUSDT',
  BTC: 'BTCUSDT',
  IBIT: 'BTCUSDT',
  GBTC: 'BTCUSDT',
  MBT: 'BTCUSDT',
  MSTR: 'BTCUSDT',
  ETHEREUM: 'ETHUSDT',
  ETH: 'ETHUSDT',
  SOLANA: 'SOLUSDT',
  SOL: 'SOLUSDT',
};

function extractBareSymbol(raw) {
  let symbol = String(raw ?? '').trim();
  if (!symbol) return '';

  symbol = symbol.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (symbol.includes(' ')) {
    symbol = symbol.split(/\s+/)[0];
  }

  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function inferBinancePairFromText(raw) {
  const text = String(raw).toLowerCase();
  if (/bitcoin|\bbtc\b|ibit|gbtc|\bmbt\b|micro bitcoin/.test(text)) {
    return 'BTCUSDT';
  }
  if (/ethereum|\beth\b/.test(text)) {
    return 'ETHUSDT';
  }
  if (/solana|\bsol\b/.test(text)) {
    return 'SOLUSDT';
  }
  return null;
}

function normalizeWatchlistSymbol(raw, broker = 'binance') {
  const bare = extractBareSymbol(raw);
  if (!bare && broker !== 'binance') {
    throw new Error(`Invalid watchlist symbol: ${raw}`);
  }

  if (broker === 'ibkr') {
    if (!bare) throw new Error(`Invalid watchlist symbol: ${raw}`);
    return bare;
  }

  if (bare.endsWith('USDT')) {
    return bare;
  }

  if (BINANCE_SYMBOL_ALIASES[bare]) {
    return BINANCE_SYMBOL_ALIASES[bare];
  }

  if (BINANCE_USDT_BASES.has(bare)) {
    return `${bare}USDT`;
  }

  const inferred = inferBinancePairFromText(raw);
  if (inferred) {
    return inferred;
  }

  throw new Error(
    `Unsupported symbol for Binance market data: ${raw}. Use pairs like BTCUSDT or ETHUSDT.`,
  );
}

function normalizeWatchlist(watchlist, broker = 'binance') {
  const normalized = watchlist.map((symbol) => normalizeWatchlistSymbol(symbol, broker));
  return [...new Set(normalized)];
}

module.exports = {
  extractBareSymbol,
  normalizeWatchlistSymbol,
  normalizeWatchlist,
};
