import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class StrategyRule {
  final String ruleId;
  final String condition;
  final String action;
  final int priority;
  final bool active;

  const StrategyRule({
    required this.ruleId,
    required this.condition,
    required this.action,
    this.priority = 1,
    this.active = true,
  });

  factory StrategyRule.fromMap(Map<String, dynamic> m) => StrategyRule(
        ruleId: m['ruleId']?.toString() ?? '',
        condition: m['condition']?.toString() ?? '',
        action: m['action']?.toString() ?? '',
        priority: parseInt(m['priority'], 1),
        active: parseBool(m['active'], true),
      );
}

class StrategyAssets {
  final String broker;
  final List<String> watchlist;

  const StrategyAssets({
    this.broker = 'binance',
    this.watchlist = const [],
  });

  factory StrategyAssets.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return StrategyAssets(
      broker: m['broker']?.toString() ?? 'binance',
      watchlist: (m['watchlist'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [],
    );
  }
}

class StrategyRisk {
  final double maxLossPerTradePct;
  final double maxDrawdownPct;
  final double maxPositionSizePct;
  final int maxOpenPositions;
  final double? minConfidenceToTrade;
  final double? stopLossPerTradePct;
  final double? takeProfitPerTradePct;
  final int earningsBlackoutDays;
  final int macroBlackoutHoursBefore;
  final int macroBlackoutHoursAfter;

  const StrategyRisk({
    this.maxLossPerTradePct = 5,
    this.maxDrawdownPct = 20,
    this.maxPositionSizePct = 25,
    this.maxOpenPositions = 3,
    this.minConfidenceToTrade,
    this.stopLossPerTradePct,
    this.takeProfitPerTradePct,
    this.earningsBlackoutDays = 0,
    this.macroBlackoutHoursBefore = 0,
    this.macroBlackoutHoursAfter = 0,
  });

  factory StrategyRisk.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return StrategyRisk(
      maxLossPerTradePct: parseDouble(m['maxLossPerTradePct'], 5),
      maxDrawdownPct: parseDouble(m['maxDrawdownPct'], 20),
      maxPositionSizePct: parseDouble(m['maxPositionSizePct'], 25),
      maxOpenPositions: parseInt(m['maxOpenPositions'], 3),
      minConfidenceToTrade: m['minConfidenceToTrade'] != null
          ? parseDouble(m['minConfidenceToTrade'])
          : null,
      stopLossPerTradePct: m['stopLossPerTradePct'] != null
          ? parseDouble(m['stopLossPerTradePct'])
          : null,
      takeProfitPerTradePct: m['takeProfitPerTradePct'] != null
          ? parseDouble(m['takeProfitPerTradePct'])
          : null,
      earningsBlackoutDays: parseInt(m['earningsBlackoutDays']),
      macroBlackoutHoursBefore: parseInt(m['macroBlackoutHoursBefore']),
      macroBlackoutHoursAfter: parseInt(m['macroBlackoutHoursAfter']),
    );
  }
}

class StrategySchedule {
  final int checkIntervalMinutes;

  const StrategySchedule({this.checkIntervalMinutes = 15});

  factory StrategySchedule.fromMap(Map<String, dynamic>? map) {
    return StrategySchedule(
      checkIntervalMinutes: parseInt(map?['checkIntervalMinutes'], 15),
    );
  }
}

class StrategyStats {
  final double totalRealizedPnlUsd;
  final double peakPortfolioValueUsd;
  final double currentDrawdownPct;
  final int totalTrades;
  final int winCount;
  final int lossCount;
  final double? sharpeRatio;
  final double claudeApiCostUsd;

  const StrategyStats({
    this.totalRealizedPnlUsd = 0,
    this.peakPortfolioValueUsd = 0,
    this.currentDrawdownPct = 0,
    this.totalTrades = 0,
    this.winCount = 0,
    this.lossCount = 0,
    this.sharpeRatio,
    this.claudeApiCostUsd = 0,
  });

  double? get winRate =>
      totalTrades > 0 ? (winCount / totalTrades) * 100 : null;

  factory StrategyStats.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return StrategyStats(
      totalRealizedPnlUsd: parseDouble(m['totalRealizedPnlUsd']),
      peakPortfolioValueUsd: parseDouble(m['peakPortfolioValueUsd']),
      currentDrawdownPct: parseDouble(m['currentDrawdownPct']),
      totalTrades: parseInt(m['totalTrades']),
      winCount: parseInt(m['winCount']),
      lossCount: parseInt(m['lossCount']),
      sharpeRatio:
          m['sharpeRatio'] != null ? parseDouble(m['sharpeRatio']) : null,
      claudeApiCostUsd: parseDouble(m['claudeApiCostUsd']),
    );
  }
}

class BrokerHealth {
  final DateTime? lastSuccessfulCycleAt;
  final int consecutiveFailures;
  final bool brokerUnreachable;

  const BrokerHealth({
    this.lastSuccessfulCycleAt,
    this.consecutiveFailures = 0,
    this.brokerUnreachable = false,
  });

  factory BrokerHealth.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return BrokerHealth(
      lastSuccessfulCycleAt: parseTimestamp(m['lastSuccessfulCycleAt']),
      consecutiveFailures: parseInt(m['consecutiveFailures']),
      brokerUnreachable: parseBool(m['brokerUnreachable']),
    );
  }
}

class StrategyModel {
  final String strategyId;
  final String userId;
  final String name;
  final String description;
  final String claudeSummary;
  final String decisionMode;
  final List<StrategyRule> rules;
  final StrategyAssets assets;
  final StrategyRisk risk;
  final StrategySchedule schedule;
  final String mode;
  final String status;
  final String? autoPausedReason;
  final DateTime? paperStartedAt;
  final DateTime? liveEnabledAt;
  final DateTime? createdAt;
  final DateTime? lastCycleAt;
  final String? lastCycleId;
  final StrategyStats stats;
  final BrokerHealth brokerHealth;

  const StrategyModel({
    required this.strategyId,
    required this.userId,
    required this.name,
    this.description = '',
    this.claudeSummary = '',
    this.decisionMode = 'rule_interpreter',
    this.rules = const [],
    this.assets = const StrategyAssets(),
    this.risk = const StrategyRisk(),
    this.schedule = const StrategySchedule(),
    this.mode = 'paper',
    this.status = 'active',
    this.autoPausedReason,
    this.paperStartedAt,
    this.liveEnabledAt,
    this.createdAt,
    this.lastCycleAt,
    this.lastCycleId,
    this.stats = const StrategyStats(),
    this.brokerHealth = const BrokerHealth(),
  });

  bool get isLive => mode == 'live';
  bool get isPaper => mode == 'paper';
  bool get isActive => status == 'active';
  bool get isPaused => status == 'paused' || status == 'auto_paused';

  factory StrategyModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return StrategyModel.fromJson(data, id: doc.id);
  }

  factory StrategyModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return StrategyModel(
      strategyId: id ?? json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      claudeSummary: json['claudeSummary']?.toString() ?? '',
      decisionMode: json['decisionMode']?.toString() ?? 'rule_interpreter',
      rules: (json['rules'] as List<dynamic>?)
              ?.map((e) => StrategyRule.fromMap(asMap(e)))
              .toList() ??
          [],
      assets: StrategyAssets.fromMap(asMap(json['assets'])),
      risk: StrategyRisk.fromMap(asMap(json['risk'])),
      schedule: StrategySchedule.fromMap(asMap(json['schedule'])),
      mode: json['mode']?.toString() ?? 'paper',
      status: json['status']?.toString() ?? 'active',
      autoPausedReason: json['autoPausedReason']?.toString(),
      paperStartedAt: parseTimestamp(json['paperStartedAt']),
      liveEnabledAt: parseTimestamp(json['liveEnabledAt']),
      createdAt: parseTimestamp(json['createdAt']),
      lastCycleAt: parseTimestamp(json['lastCycleAt']),
      lastCycleId: json['lastCycleId']?.toString(),
      stats: StrategyStats.fromMap(asMap(json['stats'])),
      brokerHealth: BrokerHealth.fromMap(asMap(json['brokerHealth'])),
    );
  }
}
