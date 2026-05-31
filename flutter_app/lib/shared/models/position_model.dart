import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class PositionModel {
  final String symbol;
  final String strategyId;
  final String userId;
  final String broker;
  final double quantity;
  final double avgCostUsd;
  final double currentPriceUsd;
  final double currentValueUsd;
  final double unrealizedPnlUsd;
  final double unrealizedPnlPct;
  final DateTime? openedAt;
  final DateTime? lastUpdatedAt;

  const PositionModel({
    required this.symbol,
    required this.strategyId,
    required this.userId,
    this.broker = 'binance',
    this.quantity = 0,
    this.avgCostUsd = 0,
    this.currentPriceUsd = 0,
    this.currentValueUsd = 0,
    this.unrealizedPnlUsd = 0,
    this.unrealizedPnlPct = 0,
    this.openedAt,
    this.lastUpdatedAt,
  });

  factory PositionModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return PositionModel.fromJson(data, id: doc.id);
  }

  factory PositionModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return PositionModel(
      symbol: id ?? json['symbol']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      broker: json['broker']?.toString() ?? 'binance',
      quantity: parseDouble(json['quantity']),
      avgCostUsd: parseDouble(json['avgCostUsd']),
      currentPriceUsd: parseDouble(json['currentPriceUsd']),
      currentValueUsd: parseDouble(json['currentValueUsd']),
      unrealizedPnlUsd: parseDouble(json['unrealizedPnlUsd']),
      unrealizedPnlPct: parseDouble(json['unrealizedPnlPct']),
      openedAt: parseTimestamp(json['openedAt']),
      lastUpdatedAt: parseTimestamp(json['lastUpdatedAt']),
    );
  }
}
