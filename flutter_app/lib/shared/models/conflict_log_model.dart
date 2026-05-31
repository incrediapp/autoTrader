import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class ConflictDecision {
  final String action;
  final String side;
  final double notionalUsd;
  final String reasoning;
  final double confidence;

  const ConflictDecision({
    this.action = 'hold',
    this.side = 'buy',
    this.notionalUsd = 0,
    this.reasoning = '',
    this.confidence = 0,
  });

  factory ConflictDecision.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return ConflictDecision(
      action: m['action']?.toString() ?? 'hold',
      side: m['side']?.toString() ?? 'buy',
      notionalUsd: parseDouble(m['notionalUsd']),
      reasoning: m['reasoning']?.toString() ?? '',
      confidence: parseDouble(m['confidence']),
    );
  }
}

class ConflictLogModel {
  final String conflictId;
  final String userId;
  final String symbol;
  final String broker;
  final String strategyAId;
  final String strategyAName;
  final ConflictDecision strategyADecision;
  final String strategyBId;
  final String strategyBName;
  final ConflictDecision strategyBDecision;
  final String resolutionRule;
  final String resolution;
  final DateTime? detectedAt;

  const ConflictLogModel({
    required this.conflictId,
    required this.userId,
    required this.symbol,
    required this.broker,
    required this.strategyAId,
    required this.strategyAName,
    required this.strategyADecision,
    required this.strategyBId,
    required this.strategyBName,
    required this.strategyBDecision,
    this.resolutionRule = 'hold_both',
    this.resolution = 'held_both',
    this.detectedAt,
  });

  factory ConflictLogModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return ConflictLogModel.fromJson(data, id: doc.id);
  }

  factory ConflictLogModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return ConflictLogModel(
      conflictId: id ?? json['conflictId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      symbol: json['symbol']?.toString() ?? '',
      broker: json['broker']?.toString() ?? '',
      strategyAId: json['strategyAId']?.toString() ?? '',
      strategyAName: json['strategyAName']?.toString() ?? '',
      strategyADecision:
          ConflictDecision.fromMap(asMap(json['strategyADecision'])),
      strategyBId: json['strategyBId']?.toString() ?? '',
      strategyBName: json['strategyBName']?.toString() ?? '',
      strategyBDecision:
          ConflictDecision.fromMap(asMap(json['strategyBDecision'])),
      resolutionRule: json['resolutionRule']?.toString() ?? 'hold_both',
      resolution: json['resolution']?.toString() ?? 'held_both',
      detectedAt: parseTimestamp(json['detectedAt']),
    );
  }
}
