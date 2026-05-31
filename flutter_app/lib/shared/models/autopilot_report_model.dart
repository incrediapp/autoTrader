import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class AutopilotProposal {
  final String proposalId;
  final String type;
  final String? targetRuleId;
  final String description;
  final String? before;
  final String? after;
  final String expectedImpact;
  final double confidence;
  final String dataEvidence;

  const AutopilotProposal({
    required this.proposalId,
    required this.type,
    this.targetRuleId,
    required this.description,
    this.before,
    this.after,
    this.expectedImpact = '',
    this.confidence = 0,
    this.dataEvidence = '',
  });

  factory AutopilotProposal.fromMap(Map<String, dynamic> m) => AutopilotProposal(
        proposalId: m['proposalId']?.toString() ?? '',
        type: m['type']?.toString() ?? '',
        targetRuleId: m['targetRuleId']?.toString(),
        description: m['description']?.toString() ?? '',
        before: m['before']?.toString(),
        after: m['after']?.toString(),
        expectedImpact: m['expectedImpact']?.toString() ?? '',
        confidence: parseDouble(m['confidence']),
        dataEvidence: m['dataEvidence']?.toString() ?? '',
      );
}

class AutopilotPerformanceSummary {
  final double winRate;
  final double totalRealizedPnlUsd;
  final double maxDrawdownPct;
  final double inactiveCyclesPct;

  const AutopilotPerformanceSummary({
    this.winRate = 0,
    this.totalRealizedPnlUsd = 0,
    this.maxDrawdownPct = 0,
    this.inactiveCyclesPct = 0,
  });

  factory AutopilotPerformanceSummary.fromMap(Map<String, dynamic>? map) {
    final m = map ?? {};
    return AutopilotPerformanceSummary(
      winRate: parseDouble(m['winRate']),
      totalRealizedPnlUsd: parseDouble(m['totalRealizedPnlUsd']),
      maxDrawdownPct: parseDouble(m['maxDrawdownPct']),
      inactiveCyclesPct: parseDouble(m['inactiveCyclesPct']),
    );
  }
}

class AutopilotReportModel {
  final String reportId;
  final String strategyId;
  final String userId;
  final DateTime? periodStart;
  final DateTime? periodEnd;
  final int tradesAnalysed;
  final AutopilotPerformanceSummary performanceSummary;
  final List<AutopilotProposal> proposals;
  final String status;
  final DateTime? generatedAt;
  final List<String> appliedProposalIds;
  final List<String> rejectedProposalIds;

  const AutopilotReportModel({
    required this.reportId,
    required this.strategyId,
    required this.userId,
    this.periodStart,
    this.periodEnd,
    this.tradesAnalysed = 0,
    this.performanceSummary = const AutopilotPerformanceSummary(),
    this.proposals = const [],
    this.status = 'pending',
    this.generatedAt,
    this.appliedProposalIds = const [],
    this.rejectedProposalIds = const [],
  });

  bool get isPending => status == 'pending';

  factory AutopilotReportModel.fromDoc(
      DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return AutopilotReportModel.fromJson(data, id: doc.id);
  }

  factory AutopilotReportModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return AutopilotReportModel(
      reportId: id ?? json['reportId']?.toString() ?? '',
      strategyId: json['strategyId']?.toString() ?? '',
      userId: json['userId']?.toString() ?? '',
      periodStart: parseTimestamp(json['periodStart']),
      periodEnd: parseTimestamp(json['periodEnd']),
      tradesAnalysed: parseInt(json['tradesAnalysed']),
      performanceSummary: AutopilotPerformanceSummary.fromMap(
        asMap(json['performanceSummary']),
      ),
      proposals: (json['proposals'] as List<dynamic>?)
              ?.map((e) => AutopilotProposal.fromMap(asMap(e)))
              .toList() ??
          [],
      status: json['status']?.toString() ?? 'pending',
      generatedAt: parseTimestamp(json['generatedAt']),
      appliedProposalIds: (json['appliedProposalIds'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [],
      rejectedProposalIds: (json['rejectedProposalIds'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [],
    );
  }
}
