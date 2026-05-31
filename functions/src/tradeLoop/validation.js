function validateDecision(decision, strategy, portfolio, marketSnapshot = null) {
  const notes = [];
  let d = { ...decision, validationApplied: false, validationNotes: [] };

  if (d.action !== 'buy' && d.action !== 'sell') {
    return { decision: d, validationNotes: notes };
  }

  d.side = d.side ?? d.action;
  d.validationApplied = true;

  if (!strategy.assets.watchlist.includes(d.symbol)) {
    notes.push(`REJECTED: Symbol ${d.symbol} not in watchlist`);
    return {
      decision: { ...d, action: 'hold', reasoning: `Rejected: unknown symbol ${d.symbol}`, validationNotes: notes },
      validationNotes: notes,
    };
  }

  const asset = marketSnapshot?.assets?.find((a) => a.symbol === d.symbol);

  if (strategy.risk?.earningsBlackoutDays > 0 && asset?.earningsContext) {
    if (asset.earningsContext.daysUntil <= strategy.risk.earningsBlackoutDays) {
      notes.push(`REJECTED: Earnings blackout for ${d.symbol}`);
      return {
        decision: {
          ...d,
          action: 'hold',
          reasoning: `Earnings blackout: ${d.symbol} reports in ${asset.earningsContext.daysUntil} day(s)`,
          validationNotes: notes,
        },
        validationNotes: notes,
      };
    }
  }

  const macroEvents = marketSnapshot?.macroEvents ?? [];
  if (strategy.risk?.macroBlackoutHoursBefore > 0) {
    const nextHigh = macroEvents.find((e) => e.impact === 'high');
    if (nextHigh) {
      const eventDate = nextHigh.eventDate?.toDate?.() ?? new Date(nextHigh.eventDate);
      const hoursUntil = (eventDate - Date.now()) / (1000 * 60 * 60);
      if (hoursUntil <= strategy.risk.macroBlackoutHoursBefore && hoursUntil >= 0) {
        notes.push(`REJECTED: Macro blackout before ${nextHigh.shortName}`);
        return {
          decision: {
            ...d,
            action: 'hold',
            reasoning: `Macro blackout: ${nextHigh.shortName} in ${hoursUntil.toFixed(1)}h`,
            validationNotes: notes,
          },
          validationNotes: notes,
        };
      }
    }
  }

  if (strategy.risk?.macroBlackoutHoursAfter > 0) {
    for (const event of macroEvents.filter((e) => e.impact === 'high')) {
      const eventDate = event.eventDate?.toDate?.() ?? new Date(event.eventDate);
      const hoursSince = (Date.now() - eventDate) / (1000 * 60 * 60);
      if (hoursSince >= 0 && hoursSince <= strategy.risk.macroBlackoutHoursAfter) {
        notes.push(`REJECTED: Macro blackout after ${event.shortName}`);
        return {
          decision: {
            ...d,
            action: 'hold',
            reasoning: `Macro blackout: ${hoursSince.toFixed(1)}h since ${event.shortName}`,
            validationNotes: notes,
          },
          validationNotes: notes,
        };
      }
    }
  }

  if (!d.notionalUsd || d.notionalUsd <= 0) {
    notes.push(`REJECTED: Invalid notionalUsd ${d.notionalUsd}`);
    return {
      decision: { ...d, action: 'hold', reasoning: 'Rejected: invalid trade size', validationNotes: notes },
      validationNotes: notes,
    };
  }

  const maxNotional = portfolio.totalValueUsd * ((strategy.risk?.maxPositionSizePct ?? 20) / 100);
  if (d.notionalUsd > maxNotional) {
    d.notionalUsd = maxNotional;
    notes.push(`CLAMPED: notionalUsd reduced to max position size ${maxNotional.toFixed(2)}`);
  }

  if ((strategy.risk?.minConfidenceToTrade ?? 0) > 0 && d.confidence !== null && d.confidence !== undefined) {
    if (d.confidence < strategy.risk.minConfidenceToTrade) {
      notes.push(`REJECTED: Confidence ${d.confidence} below minimum ${strategy.risk.minConfidenceToTrade}`);
      return {
        decision: {
          ...d,
          action: 'hold',
          reasoning: `Low confidence: ${d.confidence} < ${strategy.risk.minConfidenceToTrade}`,
          validationNotes: notes,
        },
        validationNotes: notes,
      };
    }
  }

  if (d.action === 'buy') {
    if (d.notionalUsd > portfolio.cashUsd) {
      d.notionalUsd = portfolio.cashUsd * 0.95;
      notes.push(`CLAMPED: notionalUsd reduced to 95% of cash ${(portfolio.cashUsd * 0.95).toFixed(2)}`);
    }
    if (d.notionalUsd < 1.0) {
      notes.push('REJECTED: notionalUsd below $1 minimum');
      return {
        decision: { ...d, action: 'hold', reasoning: 'Insufficient cash', validationNotes: notes },
        validationNotes: notes,
      };
    }

    const openCount = portfolio.positions.filter((p) => p.quantity > 0).length;
    if (openCount >= (strategy.risk?.maxOpenPositions ?? 5)) {
      notes.push(`REJECTED: At max open positions (${strategy.risk.maxOpenPositions})`);
      return {
        decision: { ...d, action: 'hold', reasoning: 'Max open positions reached', validationNotes: notes },
        validationNotes: notes,
      };
    }

    const existingPosition = portfolio.positions.find((p) => p.symbol === d.symbol);
    if (existingPosition) {
      const currentExposurePct = portfolio.totalValueUsd > 0
        ? (existingPosition.currentValueUsd / portfolio.totalValueUsd) * 100
        : 0;
      if (currentExposurePct >= (strategy.risk?.maxPositionSizePct ?? 20)) {
        notes.push(`REJECTED: Already at max position in ${d.symbol}`);
        return {
          decision: { ...d, action: 'hold', reasoning: `Max position size reached for ${d.symbol}`, validationNotes: notes },
          validationNotes: notes,
        };
      }
      const remainingAllowedUsd = maxNotional - existingPosition.currentValueUsd;
      if (d.notionalUsd > remainingAllowedUsd) {
        d.notionalUsd = remainingAllowedUsd;
        notes.push(`CLAMPED: notionalUsd reduced to ${remainingAllowedUsd.toFixed(2)}`);
      }
    }
  } else if (d.action === 'sell') {
    const position = portfolio.positions.find((p) => p.symbol === d.symbol);
    if (!position || position.quantity <= 0) {
      notes.push(`REJECTED: No position in ${d.symbol} to sell`);
      return {
        decision: { ...d, action: 'hold', reasoning: `No position to sell: ${d.symbol}`, validationNotes: notes },
        validationNotes: notes,
      };
    }
  }

  d.validationNotes = notes;
  return { decision: d, validationNotes: notes };
}

module.exports = {
  validateDecision,
};
