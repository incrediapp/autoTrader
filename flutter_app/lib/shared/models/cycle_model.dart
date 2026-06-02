import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class MarketAssetSnapshot {
  final String symbol;
  final double price;
  final double? rsi14;
  final double? macdHistogram;
  final double? ema20;
  final double? ema50;
  final double? ema200;
  final double priceChangePct24h;
  final Map<String, dynamic>? earningsContext;

  const MarketAssetSnapshot({
    required this.symbol,
    this.price = 0,
    this.rsi14,
    this.macdHistogram,
    this.ema20,
    this.ema50,
    this.ema200,
    this.priceChangePct24h = 0,
    this.earningsContext,
  });

  factory MarketAssetSnapshot.fromMap(Map<String, dynamic> m) =>
      MarketAssetSnapshot(
        symbol: m['symbol']?.toString() ?? '',
        price: parseDouble(m['price']),
        rsi14: m['rsi14'] != null ? parseDouble(m['rsi14']) : null,
        macdHistogram:
            m['macdHistogram'] != null ? parseDouble(m['macdHistogram']) : null,
        ema20: m['ema20'] != null ? parseDouble(m['ema20']) : null,
        ema50: m['ema50'] != null ? parseDouble(m['ema50']) : null,
        ema200: m['ema200'] != null ? parseDouble(m['ema200']) : null,
        priceChangePct24h: parseDouble(m['priceChangePct24h']),
        earningsContext: m['earningsContext'] != null
            ? asMap(m['earningsContext'])
            : null,
      );
}

class MarketSnapshot {
  final DateTime? fetchedAt;
  final int dataFreshnessMs;
  final bool dataStale;
  final List<MarketAssetSnapshot> assets;
  final int? fearGreedIndex;
  final String? fearGreedLabel;
  final List<String>? newsHeadlines;

  const MarketSnapshot({
    this.fetchedAt,
    this.dataFreshnessMs = 0,
    this.dataStale = false,
    this.assets = const [],
    this.fearGreedIndex,
    this.fearGreedLabel,
    this.newsHeadlines,
  });

  factory MarketSnapshot.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return MarketSnapshot(
      fetchedAt: parseTimestamp(m['fetchedAt']),
      dataFreshnessMs: parseInt(m['dataFreshnessMs']),
      dataStale: parseBool(m['dataStale']),
      assets: (m['assets'] as List<dynamic>?)
              ?.map((e) => MarketAssetSnapshot.fromMap(asMap(e)))
              .toList() ??
          [],
      fearGreedIndex:
          m['fearGreedIndex'] != null ? parseInt(m['fearGreedIndex']) : null,
      fearGreedLabel: m['fearGreedLabel']?.toString(),
      newsHeadlines: (m['newsHeadlines'] as List<dynamic>?)
          ?.map((e) => e.toString())
          .toList(),
    );
  }
}

class PortfolioPositionSnapshot {
  final String symbol;
  final double quantity;
  final double avgCostUsd;
  final double currentPriceUsd;
  final double unrealizedPnlUsd;
  final double unrealizedPnlPct;

  const PortfolioPositionSnapshot({
    required this.symbol,
    this.quantity = 0,
    this.avgCostUsd = 0,
    this.currentPriceUsd = 0,
    this.unrealizedPnlUsd = 0,
    this.unrealizedPnlPct = 0,
  });

  factory PortfolioPositionSnapshot.fromMap(Map<String, dynamic> m) =>
      PortfolioPositionSnapshot(
        symbol: m['symbol']?.toString() ?? '',
        quantity: parseDouble(m['quantity']),
        avgCostUsd: parseDouble(m['avgCostUsd']),
        currentPriceUsd: parseDouble(m['currentPriceUsd']),
        unrealizedPnlUsd: parseDouble(m['unrealizedPnlUsd']),
        unrealizedPnlPct: parseDouble(m['unrealizedPnlPct']),
      );
}

class PortfolioSnapshot {
  final double totalValueUsd;
  final double cashUsd;
  final List<PortfolioPositionSnapshot> positions;

  const PortfolioSnapshot({
    this.totalValueUsd = 0,
    this.cashUsd = 0,
    this.positions = const [],
  });

  factory PortfolioSnapshot.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return PortfolioSnapshot(
      totalValueUsd: parseDouble(m['totalValueUsd']),
      cashUsd: parseDouble(m['cashUsd']),
      positions: (m['positions'] as List<dynamic>?)
              ?.map((e) => PortfolioPositionSnapshot.fromMap(asMap(e)))
              .toList() ??
          [],
    );
  }
}

class CycleDecision {
  final String action;
  final String? symbol;
  final String? side;
  final String? reasoning;
  final double? confidence;
  final List<String>? validationNotes;

  const CycleDecision({
    this.action = 'hold',
    this.symbol,
    this.side,
    this.reasoning,
    this.confidence,
    this.validationNotes,
  });

  factory CycleDecision.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return CycleDecision(
      action: m['action']?.toString() ?? 'hold',
      symbol: m['symbol']?.toString(),
      side: m['side']?.toString(),
      reasoning: m['reasoning']?.toString(),
      confidence:
          m['confidence'] != null ? parseDouble(m['confidence']) : null,
      validationNotes: (m['validationNotes'] as List<dynamic>?)
          ?.map((e) => e.toString())
          .toList(),
    );
  }
}

class CycleModel {
  final String cycleId;
  final String strategyId;
  final String userId;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final int? durationMs;
  final Map<String, int?> phases;
  final MarketSnapshot marketSnapshot;
  final PortfolioSnapshot portfolioSnapshot;
  final CycleDecision decision;
  final List<String>? rulesTriggered;
  final bool tradeExecuted;
  final String? tradeId;
  final String? skippedReason;
  final bool error;
  final String? errorMessage;
  final String? claudeRawResponse;
  final String? triggeredBy;

  const CycleModel({
    required this.cycleId,
    required this.strategyId,
    required this.userId,
    this.startedAt,
    this.completedAt,
    this.durationMs,
    this.phases = const {},
    this.marketSnapshot = const MarketSnapshot(),
    this.portfolioSnapshot = const PortfolioSnapshot(),
    this.decision = const CycleDecision(),
    this.rulesTriggered,
    this.tradeExecuted = false,
    this.tradeId,
    this.skippedReason,
    this.error = false,
    this.errorMessage,
    this.claudeRawResponse,
    this.triggeredBy,
  });

  factory CycleModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return CycleModel.fromJson(data, id: doc.id);
  }

  factory CycleModel.fromJson(Map<String, dynamic> json, {String? id}) {
    final phasesRaw = asMap(json['phases']);
    final phases = phasesRaw.map(
      (k, v) => MapEntry(k, v is num ? v.toInt() : int.tryParse('$v')),
    );
    return CycleModel(
      cycleId: id ?? json['cycleId']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      startedAt: parseTimestamp(json['startedAt']),
      completedAt: parseTimestamp(json['completedAt']),
      durationMs: json['durationMs'] != null ? parseInt(json['durationMs']) : null,
      phases: phases,
      marketSnapshot: MarketSnapshot.fromMap(asMap(json['marketSnapshot'])),
      portfolioSnapshot:
          PortfolioSnapshot.fromMap(asMap(json['portfolioSnapshot'])),
      decision: CycleDecision.fromMap(asMap(json['decision'])),
      rulesTriggered: (json['rulesTriggered'] as List<dynamic>?)
          ?.map((e) => e.toString())
          .toList(),
      tradeExecuted: parseBool(json['tradeExecuted']),
      tradeId: json['tradeId']?.toString(),
      skippedReason: json['skippedReason']?.toString(),
      error: parseBool(json['error']),
      errorMessage: json['errorMessage']?.toString(),
      claudeRawResponse: json['claudeRawResponse']?.toString(),
      triggeredBy: json['triggeredBy']?.toString(),
    );
  }
}
