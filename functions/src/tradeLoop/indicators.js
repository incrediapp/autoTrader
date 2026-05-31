const {
  RSI, MACD, EMA, BollingerBands, ATR,
} = require('technicalindicators');

function computeAllIndicators(candles) {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);

  if (closes.length < 52) {
    throw new Error(`Insufficient candles for indicator computation: ${closes.length}`);
  }

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const ema20Values = EMA.calculate({ values: closes, period: 20 });
  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema200Values = closes.length >= 200
    ? EMA.calculate({ values: closes, period: 200 })
    : null;
  const bbValues = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

  const lastMacd = macdValues.at(-1);

  return {
    rsi14: rsiValues.at(-1) ?? null,
    macdLine: lastMacd?.MACD ?? null,
    macdSignal: lastMacd?.signal ?? null,
    macdHistogram: lastMacd?.histogram ?? null,
    ema20: ema20Values.at(-1) ?? null,
    ema50: ema50Values.at(-1) ?? null,
    ema200: ema200Values?.at(-1) ?? null,
    bbUpper: bbValues.at(-1)?.upper ?? null,
    bbMiddle: bbValues.at(-1)?.middle ?? null,
    bbLower: bbValues.at(-1)?.lower ?? null,
    atr14: atrValues.at(-1) ?? null,
  };
}

function buildAssetSnapshot(symbol, candles, now = Date.now()) {
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const vols = candles.map((c) => c.v);
  const newest = candles[candles.length - 1];
  const oldest24h = candles[Math.max(0, candles.length - 96)];

  const indicators = computeAllIndicators(candles);
  const dataFreshnessMs = now - newest.t;

  return {
    symbol,
    price: newest.c,
    open24h: oldest24h.o,
    high24h: Math.max(...highs.slice(-96)),
    low24h: Math.min(...lows.slice(-96)),
    close24h: newest.c,
    volume24h: vols.slice(-96).reduce((a, b) => a + b, 0),
    priceChangePct24h: oldest24h.o > 0 ? ((newest.c - oldest24h.o) / oldest24h.o) * 100 : 0,
    rsi14: indicators.rsi14 !== null ? parseFloat(Number(indicators.rsi14).toFixed(4)) : null,
    macdLine: indicators.macdLine !== null ? Number(indicators.macdLine).toFixed(6) : null,
    macdSignal: indicators.macdSignal !== null ? Number(indicators.macdSignal).toFixed(6) : null,
    macdHistogram: indicators.macdHistogram !== null ? Number(indicators.macdHistogram).toFixed(6) : null,
    ema20: indicators.ema20 !== null ? Number(indicators.ema20).toFixed(4) : null,
    ema50: indicators.ema50 !== null ? Number(indicators.ema50).toFixed(4) : null,
    ema200: indicators.ema200 !== null ? Number(indicators.ema200).toFixed(4) : null,
    bbUpper: indicators.bbUpper !== null ? Number(indicators.bbUpper).toFixed(4) : null,
    bbMiddle: indicators.bbMiddle !== null ? Number(indicators.bbMiddle).toFixed(4) : null,
    bbLower: indicators.bbLower !== null ? Number(indicators.bbLower).toFixed(4) : null,
    atr14: indicators.atr14 !== null ? Number(indicators.atr14).toFixed(4) : null,
    candlesUsed: candles.length,
    dataFreshnessMs,
  };
}

module.exports = {
  computeAllIndicators,
  buildAssetSnapshot,
};
