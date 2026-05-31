import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class ShadowStats {
  final int totalShadowTrades;
  final int shadowWinCount;
  final int shadowLossCount;
  final double shadowTotalPnlUsd;
  final double parentTotalPnlUsd;
  final bool outperforming;

  const ShadowStats({
    this.totalShadowTrades = 0,
    this.shadowWinCount = 0,
    this.shadowLossCount = 0,
    this.shadowTotalPnlUsd = 0,
    this.parentTotalPnlUsd = 0,
    this.outperforming = false,
  });

  factory ShadowStats.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return ShadowStats(
      totalShadowTrades: parseInt(m['totalShadowTrades']),
      shadowWinCount: parseInt(m['shadowWinCount']),
      shadowLossCount: parseInt(m['shadowLossCount']),
      shadowTotalPnlUsd: parseDouble(m['shadowTotalPnlUsd']),
      parentTotalPnlUsd: parseDouble(m['parentTotalPnlUsd']),
      outperforming: parseBool(m['outperforming']),
    );
  }
}

class ShadowConfigModel {
  final String shadowId;
  final String strategyId;
  final String userId;
  final String name;
  final String description;
  final String status;
  final DateTime? startedAt;
  final ShadowStats stats;

  const ShadowConfigModel({
    required this.shadowId,
    required this.strategyId,
    required this.userId,
    required this.name,
    this.description = '',
    this.status = 'active',
    this.startedAt,
    this.stats = const ShadowStats(),
  });

  factory ShadowConfigModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return ShadowConfigModel.fromJson(data, id: doc.id);
  }

  factory ShadowConfigModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return ShadowConfigModel(
      shadowId: id ?? json['shadowId']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      status: json['status']?.toString() ?? 'active',
      startedAt: parseTimestamp(json['startedAt']),
      stats: ShadowStats.fromMap(asMap(json['stats'])),
    );
  }
}
