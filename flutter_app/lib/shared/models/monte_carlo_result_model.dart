import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class HistogramData {
  final List<double> buckets;
  final List<int> counts;

  const HistogramData({this.buckets = const [], this.counts = const []});

  factory HistogramData.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return HistogramData(
      buckets: (m['buckets'] as List<dynamic>?)
              ?.map((e) => parseDouble(e))
              .toList() ??
          [],
      counts: (m['counts'] as List<dynamic>?)
              ?.map((e) => parseInt(e))
              .toList() ??
          [],
    );
  }
}

class MonteCarloResults {
  final double p5FinalValueUsd;
  final double p25FinalValueUsd;
  final double p50FinalValueUsd;
  final double p75FinalValueUsd;
  final double p95FinalValueUsd;
  final double meanFinalValueUsd;
  final double probabilityOfRuin20Pct;
  final double probabilityOfRuin50Pct;
  final HistogramData maxDrawdownDistribution;
  final List<List<double>> equityCurves;
  final HistogramData returnsHistogram;

  const MonteCarloResults({
    this.p5FinalValueUsd = 0,
    this.p25FinalValueUsd = 0,
    this.p50FinalValueUsd = 0,
    this.p75FinalValueUsd = 0,
    this.p95FinalValueUsd = 0,
    this.meanFinalValueUsd = 0,
    this.probabilityOfRuin20Pct = 0,
    this.probabilityOfRuin50Pct = 0,
    this.maxDrawdownDistribution = const HistogramData(),
    this.equityCurves = const [],
    this.returnsHistogram = const HistogramData(),
  });

  factory MonteCarloResults.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return MonteCarloResults(
      p5FinalValueUsd: parseDouble(m['p5FinalValueUsd']),
      p25FinalValueUsd: parseDouble(m['p25FinalValueUsd']),
      p50FinalValueUsd: parseDouble(m['p50FinalValueUsd']),
      p75FinalValueUsd: parseDouble(m['p75FinalValueUsd']),
      p95FinalValueUsd: parseDouble(m['p95FinalValueUsd']),
      meanFinalValueUsd: parseDouble(m['meanFinalValueUsd']),
      probabilityOfRuin20Pct: parseDouble(m['probabilityOfRuin20Pct']),
      probabilityOfRuin50Pct: parseDouble(m['probabilityOfRuin50Pct']),
      maxDrawdownDistribution:
          HistogramData.fromMap(asMap(m['maxDrawdownDistribution'])),
      equityCurves: (m['equityCurves'] as List<dynamic>?)
              ?.map((curve) => (curve as List<dynamic>)
                  .map((v) => parseDouble(v))
                  .toList())
              .toList() ??
          [],
      returnsHistogram: HistogramData.fromMap(asMap(m['returnsHistogram'])),
    );
  }
}

class MonteCarloResultModel {
  final String resultId;
  final String strategyId;
  final String userId;
  final double startingCapitalUsd;
  final int simulationPeriodDays;
  final int simulationCount;
  final double winRate;
  final double avgWinPct;
  final double avgLossPct;
  final MonteCarloResults results;
  final DateTime? generatedAt;
  final String dataSource;
  final int tradesUsedForParams;

  const MonteCarloResultModel({
    required this.resultId,
    required this.strategyId,
    required this.userId,
    this.startingCapitalUsd = 20,
    this.simulationPeriodDays = 90,
    this.simulationCount = 1000,
    this.winRate = 0,
    this.avgWinPct = 0,
    this.avgLossPct = 0,
    this.results = const MonteCarloResults(),
    this.generatedAt,
    this.dataSource = 'paper_trades',
    this.tradesUsedForParams = 0,
  });

  factory MonteCarloResultModel.fromDoc(
      DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return MonteCarloResultModel.fromJson(data, id: doc.id);
  }

  factory MonteCarloResultModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return MonteCarloResultModel(
      resultId: id ?? json['resultId']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      startingCapitalUsd: parseDouble(json['startingCapitalUsd'], 20),
      simulationPeriodDays: parseInt(json['simulationPeriodDays'], 90),
      simulationCount: parseInt(json['simulationCount'], 1000),
      winRate: parseDouble(json['winRate']),
      avgWinPct: parseDouble(json['avgWinPct']),
      avgLossPct: parseDouble(json['avgLossPct']),
      results: MonteCarloResults.fromMap(asMap(json['results'])),
      generatedAt: parseTimestamp(json['generatedAt']),
      dataSource: json['dataSource']?.toString() ?? 'paper_trades',
      tradesUsedForParams: parseInt(json['tradesUsedForParams']),
    );
  }
}
