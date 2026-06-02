import 'timestamp_utils.dart';

class AnalyticsQuery {
  final String range;
  final String? strategyId;
  final String? mode;

  const AnalyticsQuery({
    this.range = '30D',
    this.strategyId,
    this.mode,
  });

  Map<String, dynamic> toJson() => {
        'range': range,
        if (strategyId != null) 'strategyId': strategyId,
        if (mode != null) 'mode': mode,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AnalyticsQuery &&
          range == other.range &&
          strategyId == other.strategyId &&
          mode == other.mode;

  @override
  int get hashCode => Object.hash(range, strategyId, mode);
}

class EquityPoint {
  final DateTime date;
  final double value;
  final String? strategyId;

  const EquityPoint({
    required this.date,
    required this.value,
    this.strategyId,
  });

  factory EquityPoint.fromMap(Map<String, dynamic> m) => EquityPoint(
        date: parseTimestamp(m['date']) ?? DateTime.now(),
        value: parseDouble(m['value']),
        strategyId: m['strategyId']?.toString(),
      );
}

class StrategyComparisonRow {
  final String strategyId;
  final String name;
  final int trades;
  final double winRate;
  final double pnlUsd;
  final double? sharpe;
  final double maxDrawdownPct;
  final double claudeCostUsd;
  final String mode;

  const StrategyComparisonRow({
    required this.strategyId,
    required this.name,
    this.trades = 0,
    this.winRate = 0,
    this.pnlUsd = 0,
    this.sharpe,
    this.maxDrawdownPct = 0,
    this.claudeCostUsd = 0,
    this.mode = 'paper',
  });

  factory StrategyComparisonRow.fromMap(Map<String, dynamic> m) =>
      StrategyComparisonRow(
        strategyId: m['strategyId']?.toString() ?? '',
        name: m['name']?.toString() ?? '',
        trades: parseInt(m['trades']),
        winRate: parseDouble(m['winRate']),
        pnlUsd: parseDouble(m['pnlUsd']),
        sharpe: m['sharpe'] != null ? parseDouble(m['sharpe']) : null,
        maxDrawdownPct: parseDouble(m['maxDrawdownPct']),
        claudeCostUsd: parseDouble(m['claudeCostUsd']),
        mode: m['mode']?.toString() ?? 'paper',
      );
}

class AnalyticsData {
  final double totalPnlUsd;
  final double totalPnlPct;
  final double winRate;
  final int winCount;
  final int totalTrades;
  final double? sharpeRatio;
  final double maxDrawdownPct;
  final double claudeCostUsd;
  final List<EquityPoint> equityCurve;
  final List<EquityPoint> drawdownSeries;
  final List<Map<String, dynamic>> pnlByAsset;
  final List<Map<String, dynamic>> tradeDistribution;
  final List<Map<String, dynamic>> tradeFrequency;
  final List<Map<String, dynamic>> claudeCostPerDay;
  final List<StrategyComparisonRow> strategyComparison;

  const AnalyticsData({
    this.totalPnlUsd = 0,
    this.totalPnlPct = 0,
    this.winRate = 0,
    this.winCount = 0,
    this.totalTrades = 0,
    this.sharpeRatio,
    this.maxDrawdownPct = 0,
    this.claudeCostUsd = 0,
    this.equityCurve = const [],
    this.drawdownSeries = const [],
    this.pnlByAsset = const [],
    this.tradeDistribution = const [],
    this.tradeFrequency = const [],
    this.claudeCostPerDay = const [],
    this.strategyComparison = const [],
  });

  factory AnalyticsData.fromJson(Map<String, dynamic> json) {
    return AnalyticsData(
      totalPnlUsd: parseDouble(json['totalPnlUsd']),
      totalPnlPct: parseDouble(json['totalPnlPct']),
      winRate: parseDouble(json['winRate']),
      winCount: parseInt(json['winCount']),
      totalTrades: parseInt(json['totalTrades']),
      sharpeRatio:
          json['sharpeRatio'] != null ? parseDouble(json['sharpeRatio']) : null,
      maxDrawdownPct: parseDouble(json['maxDrawdownPct']),
      claudeCostUsd: parseDouble(json['claudeCostUsd']),
      equityCurve: (json['equityCurve'] as List<dynamic>?)
              ?.map((e) => EquityPoint.fromMap(asMap(e)))
              .toList() ??
          [],
      drawdownSeries: (json['drawdownSeries'] as List<dynamic>?)
              ?.map((e) => EquityPoint.fromMap(asMap(e)))
              .toList() ??
          [],
      pnlByAsset: (json['pnlByAsset'] as List<dynamic>?)
              ?.map((e) => asMap(e))
              .toList() ??
          [],
      tradeDistribution: (json['tradeDistribution'] as List<dynamic>?)
              ?.map((e) => asMap(e))
              .toList() ??
          [],
      tradeFrequency: (json['tradeFrequency'] as List<dynamic>?)
              ?.map((e) => asMap(e))
              .toList() ??
          [],
      claudeCostPerDay: (json['claudeCostPerDay'] as List<dynamic>?)
              ?.map((e) => asMap(e))
              .toList() ??
          [],
      strategyComparison: (json['strategyComparison'] as List<dynamic>?)
              ?.map((e) => StrategyComparisonRow.fromMap(asMap(e)))
              .toList() ??
          [],
    );
  }
}
