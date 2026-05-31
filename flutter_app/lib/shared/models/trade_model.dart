import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class PostMortemModel {
  final bool generated;
  final DateTime? generatedAt;
  final String? type;
  final String? summary;
  final String? whatHappened;
  final String? signalQuality;
  final List<String>? missedContext;
  final List<String>? lessonsForStrategy;

  const PostMortemModel({
    this.generated = false,
    this.generatedAt,
    this.type,
    this.summary,
    this.whatHappened,
    this.signalQuality,
    this.missedContext,
    this.lessonsForStrategy,
  });

  factory PostMortemModel.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return PostMortemModel(
      generated: parseBool(m['generated']),
      generatedAt: parseTimestamp(m['generatedAt']),
      type: m['type']?.toString(),
      summary: m['summary']?.toString(),
      whatHappened: m['whatHappened']?.toString(),
      signalQuality: m['signalQuality']?.toString(),
      missedContext: (m['missedContext'] as List<dynamic>?)
          ?.map((e) => e.toString())
          .toList(),
      lessonsForStrategy: (m['lessonsForStrategy'] as List<dynamic>?)
          ?.map((e) => e.toString())
          .toList(),
    );
  }
}

class TradeModel {
  final String tradeId;
  final String strategyId;
  final String userId;
  final String cycleId;
  final String broker;
  final String symbol;
  final String side;
  final String mode;
  final String source;
  final double executedQuantity;
  final double executedPriceUsd;
  final double executedNotionalUsd;
  final double feeUsd;
  final double? realizedPnlUsd;
  final double? realizedPnlPct;
  final int? holdingPeriodMs;
  final String claudeReasoning;
  final double? claudeConfidence;
  final List<String>? rulesTriggered;
  final DateTime? executedAt;
  final PostMortemModel? postMortem;

  const TradeModel({
    required this.tradeId,
    required this.strategyId,
    required this.userId,
    required this.cycleId,
    this.broker = 'binance',
    required this.symbol,
    required this.side,
    this.mode = 'paper',
    this.source = 'strategy',
    this.executedQuantity = 0,
    this.executedPriceUsd = 0,
    this.executedNotionalUsd = 0,
    this.feeUsd = 0,
    this.realizedPnlUsd,
    this.realizedPnlPct,
    this.holdingPeriodMs,
    this.claudeReasoning = '',
    this.claudeConfidence,
    this.rulesTriggered,
    this.executedAt,
    this.postMortem,
  });

  factory TradeModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return TradeModel.fromJson(data, id: doc.id);
  }

  factory TradeModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return TradeModel(
      tradeId: id ?? json['tradeId']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      cycleId: json['cycleId']?.toString() ?? '',
      broker: json['broker']?.toString() ?? 'binance',
      symbol: json['symbol']?.toString() ?? '',
      side: json['side']?.toString() ?? 'buy',
      mode: json['mode']?.toString() ?? 'paper',
      source: json['source']?.toString() ?? 'strategy',
      executedQuantity: parseDouble(json['executedQuantity']),
      executedPriceUsd: parseDouble(json['executedPriceUsd']),
      executedNotionalUsd: parseDouble(json['executedNotionalUsd']),
      feeUsd: parseDouble(json['feeUsd']),
      realizedPnlUsd: json['realizedPnlUsd'] != null
          ? parseDouble(json['realizedPnlUsd'])
          : null,
      realizedPnlPct: json['realizedPnlPct'] != null
          ? parseDouble(json['realizedPnlPct'])
          : null,
      holdingPeriodMs: json['holdingPeriodMs'] != null
          ? parseInt(json['holdingPeriodMs'])
          : null,
      claudeReasoning: json['claudeReasoning']?.toString() ?? '',
      claudeConfidence: json['claudeConfidence'] != null
          ? parseDouble(json['claudeConfidence'])
          : null,
      rulesTriggered: (json['rulesTriggered'] as List<dynamic>?)
          ?.map((e) => e.toString())
          .toList(),
      executedAt: parseTimestamp(json['executedAt']),
      postMortem: json['postMortem'] != null
          ? PostMortemModel.fromMap(asMap(json['postMortem']))
          : null,
    );
  }
}
