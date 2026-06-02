function getBaselineVars(market, strategy) {
  const vars = {};
  const configs = strategy?.signals ?? [];

  for (const cfg of configs) {
    const marketKey = cfg.marketKey ?? cfg.id;
    const node = market.crossMarket?.[marketKey];
    const idUpper = cfg.id.toUpperCase();
    vars[`${idUpper}_CHANGE_SINCE_BASELINE`] = (node?.changeSinceBaselinePct ?? 0) / 100;
    vars[`${idUpper}_CHANGE_SINCE_BASELINE_ABS`] = (node?.changeSinceBaselineAbsPct ?? 0) / 100;
    vars[`${idUpper}_BASELINE_MOVE_MET`] = node?.meetsMoveThreshold ? 1 : 0;
    vars[`${idUpper}_IS_FIRST_BASELINE`] = node?.isFirstBaseline ? 1 : 0;
  }

  const dxy = market.crossMarket?.dxy;
  if (dxy) {
    vars.DXY_CHANGE_SINCE_BASELINE = (dxy.changeSinceBaselinePct ?? 0) / 100;
    vars.DXY_CHANGE_SINCE_BASELINE_ABS = (dxy.changeSinceBaselineAbsPct ?? 0) / 100;
    vars.DXY_BASELINE_MOVE_MET = dxy.meetsMoveThreshold ? 1 : 0;
    vars.DXY_IS_FIRST_BASELINE = dxy.isFirstBaseline ? 1 : 0;
  }

  return vars;
}

function getIndicatorVars(market, portfolio, symbol, strategy = null) {
  const asset = market.assets?.find((a) => a.symbol === symbol)
    ?? market.assets?.[0];
  if (!asset) return {};

  const position = portfolio.positions?.find((p) => p.symbol === symbol);
  const symKey = symbol.replace(/[^A-Z0-9]/gi, '');

  return {
    ...getBaselineVars(market, strategy),
    RSI_14: asset.rsi14 ?? 0,
    MACD_LINE: parseFloat(asset.macdLine) || 0,
    MACD_SIGNAL: parseFloat(asset.macdSignal) || 0,
    MACD_HISTOGRAM: parseFloat(asset.macdHistogram) || 0,
    EMA_20: parseFloat(asset.ema20) || 0,
    EMA_50: parseFloat(asset.ema50) || 0,
    EMA_200: parseFloat(asset.ema200) || 0,
    BB_UPPER: parseFloat(asset.bbUpper) || 0,
    BB_LOWER: parseFloat(asset.bbLower) || 0,
    ATR_14: parseFloat(asset.atr14) || 0,
    PRICE: asset.price ?? 0,
    PRICE_CHANGE_24H: (asset.priceChangePct24h ?? 0) / 100,
    VOLUME_24H: asset.volume24h ?? 0,
    FEAR_GREED: market.fearGreedIndex ?? 50,
    NASDAQ_1H_GREEN: market.crossMarket?.computedSignals?.nasdaq1hGreen ? 1 : 0,
    BITCOIN_1H_UP: market.crossMarket?.computedSignals?.bitcoin1hUp ? 1 : 0,
    BITCOIN_24H_UP: market.crossMarket?.computedSignals?.bitcoin24hUp ? 1 : 0,
    DXY_DOWN_3PCT: (market.crossMarket?.computedSignals?.dxyDownOver3Pct5d
      || market.crossMarket?.computedSignals?.dxyDownOver3Pct24h) ? 1 : 0,
    BULLISH_CONDITION_COUNT: market.crossMarket?.computedSignals?.bullishConditionCount ?? 0,
    PORTFOLIO_VALUE: portfolio.totalValueUsd ?? 0,
    CASH_USD: portfolio.cashUsd ?? 0,
    [`POSITION_${symKey}`]: position?.currentValueUsd ?? 0,
    [`POSITION_PNL_${symKey}`]: (position?.unrealizedPnlPct ?? 0) / 100,
  };
}

function tokenizeCondition(condition) {
  return condition
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
}

function evaluateSimpleExpression(tokens, vars) {
  const stack = [];
  let i = 0;

  function parseValue(token) {
    if (token in vars) return vars[token];
    if (token === 'true') return true;
    if (token === 'false') return false;
    const num = parseFloat(token);
    if (!Number.isNaN(num)) return num;
    if (token.startsWith('POSITION_') || token.startsWith('POSITION_PNL_')) {
      return vars[token] ?? 0;
    }
    return vars[token] ?? 0;
  }

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === 'AND') {
      const b = stack.pop();
      const a = stack.pop();
      stack.push(Boolean(a) && Boolean(b));
    } else if (token === 'OR') {
      const b = stack.pop();
      const a = stack.pop();
      stack.push(Boolean(a) || Boolean(b));
    } else if (token === 'NOT') {
      stack.push(!stack.pop());
    } else if (['<', '>', '<=', '>=', '==', '!='].includes(token)) {
      const right = parseValue(tokens[i + 1]);
      const left = stack.pop();
      i++;
      switch (token) {
        case '<': stack.push(left < right); break;
        case '>': stack.push(left > right); break;
        case '<=': stack.push(left <= right); break;
        case '>=': stack.push(left >= right); break;
        case '==': stack.push(left === right); break;
        case '!=': stack.push(left !== right); break;
        default: break;
      }
    } else if (token !== '(' && token !== ')') {
      if (i + 1 < tokens.length && ['<', '>', '<=', '>=', '==', '!='].includes(tokens[i + 1])) {
        stack.push(parseValue(token));
      } else if (!['AND', 'OR', 'NOT'].includes(token)) {
        stack.push(parseValue(token));
      }
    }
    i++;
  }

  return stack.length ? stack[stack.length - 1] : false;
}

function evaluateCondition(condition, market, portfolio, strategy = null) {
  try {
    const symbols = market.assets?.map((a) => a.symbol) ?? [];
    for (const symbol of symbols) {
      const vars = getIndicatorVars(market, portfolio, symbol, strategy);
      const expanded = condition.replace(
        /POSITION_PNL_([A-Z0-9]+)|POSITION_([A-Z0-9]+)/g,
        (match) => match,
      );
      const tokens = tokenizeCondition(expanded);
      const resolvedTokens = tokens.map((t) => {
        if (t in vars) return String(vars[t]);
        return t;
      });
      if (evaluateSimpleExpression(resolvedTokens, vars)) return true;
    }

    const primarySymbol = market.assets?.[0]?.symbol;
    if (primarySymbol) {
      const vars = getIndicatorVars(market, portfolio, primarySymbol, strategy);
      const tokens = tokenizeCondition(condition);
      const resolvedTokens = tokens.map((t) => (t in vars ? String(vars[t]) : t));
      return Boolean(evaluateSimpleExpression(resolvedTokens, vars));
    }
    return false;
  } catch {
    return false;
  }
}

function parseActionFromRule(rule) {
  const action = rule.action.toUpperCase();
  if (action.includes('BUY')) return 'buy';
  if (action.includes('SELL')) return 'sell';
  return 'hold';
}

function parseSymbolFromRule(rule) {
  const match = rule.action.match(/(?:BUY|SELL)\s+([A-Z0-9]+)/i);
  return match?.[1] ?? rule.action.match(/([A-Z]{2,10}USDT|[A-Z]{1,5})/)?.[1] ?? null;
}

function parseSideFromRule(rule) {
  return parseActionFromRule(rule) === 'sell' ? 'sell' : 'buy';
}

function parseNotionalFromRule(rule, portfolio) {
  const action = rule.action.toUpperCase();
  const pctCash = action.match(/(\d+(?:\.\d+)?)\s*%\s*OF\s*CASH/);
  if (pctCash) {
    return portfolio.cashUsd * (parseFloat(pctCash[1]) / 100);
  }
  const usdAmt = action.match(/(\d+(?:\.\d+)?)\s*USD/);
  if (usdAmt) return parseFloat(usdAmt[1]);

  const dollarSign = action.match(/\$(\d+(?:\.\d+)?)/);
  if (dollarSign) return parseFloat(dollarSign[1]);

  const pctPos = action.match(/(\d+(?:\.\d+)?)\s*%\s*OF\s*POSITION/);
  if (pctPos) {
    const symbol = parseSymbolFromRule(rule);
    const pos = portfolio.positions?.find((p) => p.symbol === symbol);
    return (pos?.currentValueUsd ?? 0) * (parseFloat(pctPos[1]) / 100);
  }

  if (action.includes('ALL')) {
    const symbol = parseSymbolFromRule(rule);
    const pos = portfolio.positions?.find((p) => p.symbol === symbol);
    return pos?.currentValueUsd ?? portfolio.cashUsd * 0.1;
  }

  return portfolio.cashUsd * 0.1;
}

function applyProposalToRules(rules, proposal) {
  const updated = [...rules];

  switch (proposal.type) {
    case 'modify_rule':
    case 'adjust_threshold':
    case 'add_condition': {
      const idx = updated.findIndex((r) => r.ruleId === proposal.targetRuleId);
      if (idx >= 0 && proposal.after) {
        const parts = proposal.after.split(' THEN ');
        if (parts.length === 2) {
          updated[idx] = { ...updated[idx], condition: parts[0].replace(/^IF\s+/i, ''), action: parts[1] };
        } else {
          updated[idx] = { ...updated[idx], condition: proposal.after };
        }
      }
      break;
    }
    case 'add_rule':
      if (proposal.after) {
        updated.push({
          ruleId: proposal.proposalId,
          condition: proposal.after.split(' THEN ')[0]?.replace(/^IF\s+/i, '') ?? proposal.after,
          action: proposal.after.split(' THEN ')[1] ?? proposal.after,
          priority: updated.length + 1,
          active: true,
          createdAt: new Date(),
          triggerCount: 0,
          lastTriggeredAt: null,
        });
      }
      break;
    case 'remove_rule':
      return updated.filter((r) => r.ruleId !== proposal.targetRuleId);
    default:
      break;
  }

  return updated;
}

module.exports = {
  evaluateCondition,
  parseActionFromRule,
  parseSymbolFromRule,
  parseSideFromRule,
  parseNotionalFromRule,
  applyProposalToRules,
  getIndicatorVars,
  getBaselineVars,
};
