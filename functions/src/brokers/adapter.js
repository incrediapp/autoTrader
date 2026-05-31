const { BinanceAdapter } = require('./binance');
const { IBKRAdapter } = require('./ibkr');

function getBrokerAdapter(broker, userId, isPaper = false, ctx = {}) {
  if (broker === 'binance') return new BinanceAdapter(userId, isPaper, ctx);
  if (broker === 'ibkr') return new IBKRAdapter(userId, isPaper, ctx);
  throw new Error(`Unknown broker: ${broker}`);
}

async function pingBroker(broker, userId, isPaper = false) {
  try {
    const adapter = getBrokerAdapter(broker, userId, isPaper);
    return await adapter.ping();
  } catch {
    return false;
  }
}

async function fetchPortfolio(strategy, userId) {
  const isPaper = strategy.mode === 'paper';
  const adapter = getBrokerAdapter(strategy.assets.broker, userId, isPaper, {
    userId,
    strategyId: strategy.strategyId,
    strategy,
  });
  return adapter.fetchPortfolio();
}

async function fetchOHLCV(broker, userId, symbol, interval, limit, isPaper = false) {
  const adapter = getBrokerAdapter(broker, userId, isPaper);
  return adapter.fetchOHLCV(symbol, interval, limit);
}

module.exports = {
  getBrokerAdapter,
  pingBroker,
  fetchPortfolio,
  fetchOHLCV,
};
