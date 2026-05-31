import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class SystemMetrics {
  final DateTime? updatedAt;
  final int totalUsers;
  final int activeUsersLast24h;
  final int activeStrategies;
  final int liveStrategies;
  final int paperStrategies;
  final int cyclesToday;
  final int tradesToday;
  final int liveTradesToday;
  final int paperTradesToday;
  final double claudeCostUsdToday;
  final double claudeCostUsdThisMonth;
  final double errorRatePctToday;
  final int errorCyclesToday;

  const SystemMetrics({
    this.updatedAt,
    this.totalUsers = 0,
    this.activeUsersLast24h = 0,
    this.activeStrategies = 0,
    this.liveStrategies = 0,
    this.paperStrategies = 0,
    this.cyclesToday = 0,
    this.tradesToday = 0,
    this.liveTradesToday = 0,
    this.paperTradesToday = 0,
    this.claudeCostUsdToday = 0,
    this.claudeCostUsdThisMonth = 0,
    this.errorRatePctToday = 0,
    this.errorCyclesToday = 0,
  });

  factory SystemMetrics.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    return SystemMetrics.fromJson(doc.data() ?? {});
  }

  factory SystemMetrics.fromJson(Map<String, dynamic> json) {
    return SystemMetrics(
      updatedAt: parseTimestamp(json['updatedAt']),
      totalUsers: parseInt(json['totalUsers']),
      activeUsersLast24h: parseInt(json['activeUsersLast24h']),
      activeStrategies: parseInt(json['activeStrategies']),
      liveStrategies: parseInt(json['liveStrategies']),
      paperStrategies: parseInt(json['paperStrategies']),
      cyclesToday: parseInt(json['cyclesToday']),
      tradesToday: parseInt(json['tradesToday']),
      liveTradesToday: parseInt(json['liveTradesToday']),
      paperTradesToday: parseInt(json['paperTradesToday']),
      claudeCostUsdToday: parseDouble(json['claudeCostUsdToday']),
      claudeCostUsdThisMonth: parseDouble(json['claudeCostUsdThisMonth']),
      errorRatePctToday: parseDouble(json['errorRatePctToday']),
      errorCyclesToday: parseInt(json['errorCyclesToday']),
    );
  }
}
