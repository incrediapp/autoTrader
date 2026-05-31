import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class UserBrokers {
  final bool binanceConnected;
  final bool ibkrConnected;
  final DateTime? binanceConnectedAt;
  final DateTime? ibkrConnectedAt;
  final DateTime? ibkrTokenExpiresAt;

  const UserBrokers({
    this.binanceConnected = false,
    this.ibkrConnected = false,
    this.binanceConnectedAt,
    this.ibkrConnectedAt,
    this.ibkrTokenExpiresAt,
  });

  factory UserBrokers.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    final binance = asMap(m['binance']);
    final ibkr = asMap(m['ibkr']);
    return UserBrokers(
      binanceConnected: parseBool(binance['connected']),
      ibkrConnected: parseBool(ibkr['connected']),
      binanceConnectedAt: parseTimestamp(binance['connectedAt']),
      ibkrConnectedAt: parseTimestamp(ibkr['connectedAt']),
      ibkrTokenExpiresAt: parseTimestamp(ibkr['tokenExpiresAt']),
    );
  }

  bool get hasAnyBroker => binanceConnected || ibkrConnected;
}

class UserOnboarding {
  final List<String> completedSteps;
  final DateTime? completedAt;

  const UserOnboarding({
    this.completedSteps = const [],
    this.completedAt,
  });

  bool get isComplete => completedAt != null;

  factory UserOnboarding.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return UserOnboarding(
      completedSteps: (m['completedSteps'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [],
      completedAt: parseTimestamp(m['completedAt']),
    );
  }
}

class UserStats {
  final int totalStrategies;
  final int activeStrategies;
  final int liveStrategies;
  final double totalRealizedPnlUsd;
  final double claudeApiCostUsdTotal;

  const UserStats({
    this.totalStrategies = 0,
    this.activeStrategies = 0,
    this.liveStrategies = 0,
    this.totalRealizedPnlUsd = 0,
    this.claudeApiCostUsdTotal = 0,
  });

  factory UserStats.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return UserStats(
      totalStrategies: parseInt(m['totalStrategies']),
      activeStrategies: parseInt(m['activeStrategies']),
      liveStrategies: parseInt(m['liveStrategies']),
      totalRealizedPnlUsd: parseDouble(m['totalRealizedPnlUsd']),
      claudeApiCostUsdTotal: parseDouble(m['claudeApiCostUsdTotal']),
    );
  }
}

class ConflictResolutionConfig {
  final String rule;

  const ConflictResolutionConfig({this.rule = 'hold_both'});

  factory ConflictResolutionConfig.fromMap(Map<String, dynamic>? map) {
    return ConflictResolutionConfig(
      rule: map?['rule']?.toString() ?? 'hold_both',
    );
  }
}

class UserModel {
  final String uid;
  final String email;
  final String displayName;
  final String role;
  final String status;
  final DateTime? createdAt;
  final DateTime? lastActiveAt;
  final UserBrokers brokers;
  final UserOnboarding onboarding;
  final UserStats stats;
  final ConflictResolutionConfig conflictResolution;

  const UserModel({
    required this.uid,
    required this.email,
    required this.displayName,
    this.role = 'user',
    this.status = 'active',
    this.createdAt,
    this.lastActiveAt,
    this.brokers = const UserBrokers(),
    this.onboarding = const UserOnboarding(),
    this.stats = const UserStats(),
    this.conflictResolution = const ConflictResolutionConfig(),
  });

  bool get isAdmin => role == 'admin';

  factory UserModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return UserModel.fromJson(data, id: doc.id);
  }

  factory UserModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return UserModel(
      uid: id ?? json['uid']?.toString() ?? '',
      email: json['email']?.toString() ?? '',
      displayName: json['displayName']?.toString() ?? '',
      role: json['role']?.toString() ?? 'user',
      status: json['status']?.toString() ?? 'active',
      createdAt: parseTimestamp(json['createdAt']),
      lastActiveAt: parseTimestamp(json['lastActiveAt']),
      brokers: UserBrokers.fromMap(asMap(json['brokers'])),
      onboarding: UserOnboarding.fromMap(asMap(json['onboarding'])),
      stats: UserStats.fromMap(asMap(json['stats'])),
      conflictResolution: ConflictResolutionConfig.fromMap(
        asMap(json['conflictResolution']),
      ),
    );
  }
}
