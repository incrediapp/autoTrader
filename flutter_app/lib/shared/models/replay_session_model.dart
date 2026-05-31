import 'package:cloud_firestore/cloud_firestore.dart';

import 'cycle_model.dart';
import 'timestamp_utils.dart';
import 'trade_model.dart';

class ReplayStepModel {
  final int stepIndex;
  final DateTime? timestamp;
  final MarketSnapshot marketSnapshot;
  final PortfolioSnapshot portfolioSnapshot;
  final CycleDecision decision;
  final bool tradeExecuted;
  final TradeModel? trade;

  const ReplayStepModel({
    required this.stepIndex,
    this.timestamp,
    this.marketSnapshot = const MarketSnapshot(),
    this.portfolioSnapshot = const PortfolioSnapshot(),
    this.decision = const CycleDecision(),
    this.tradeExecuted = false,
    this.trade,
  });

  factory ReplayStepModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return ReplayStepModel.fromJson(data, id: doc.id);
  }

  factory ReplayStepModel.fromJson(Map<String, dynamic> json, {String? id}) {
    TradeModel? trade;
    if (json['trade'] != null) {
      trade = TradeModel.fromJson(asMap(json['trade']));
    }
    return ReplayStepModel(
      stepIndex: parseInt(json['stepIndex'] ?? id),
      timestamp: parseTimestamp(json['timestamp']),
      marketSnapshot: MarketSnapshot.fromMap(asMap(json['marketSnapshot'])),
      portfolioSnapshot:
          PortfolioSnapshot.fromMap(asMap(json['portfolioSnapshot'])),
      decision: CycleDecision.fromMap(asMap(json['decision'])),
      tradeExecuted: parseBool(json['tradeExecuted']),
      trade: trade,
    );
  }
}

class ReplaySessionModel {
  final String sessionId;
  final String strategyId;
  final String userId;
  final DateTime? startDate;
  final DateTime? endDate;
  final String status;
  final int progress;
  final int totalSteps;
  final int completedSteps;
  final DateTime? generatedAt;

  const ReplaySessionModel({
    required this.sessionId,
    required this.strategyId,
    required this.userId,
    this.startDate,
    this.endDate,
    this.status = 'generating',
    this.progress = 0,
    this.totalSteps = 0,
    this.completedSteps = 0,
    this.generatedAt,
  });

  bool get isReady => status == 'ready';

  factory ReplaySessionModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return ReplaySessionModel.fromJson(data, id: doc.id);
  }

  factory ReplaySessionModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return ReplaySessionModel(
      sessionId: id ?? json['sessionId']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      startDate: parseTimestamp(json['startDate']),
      endDate: parseTimestamp(json['endDate']),
      status: json['status']?.toString() ?? 'generating',
      progress: parseInt(json['progress']),
      totalSteps: parseInt(json['totalSteps']),
      completedSteps: parseInt(json['completedSteps']),
      generatedAt: parseTimestamp(json['generatedAt']),
    );
  }
}
