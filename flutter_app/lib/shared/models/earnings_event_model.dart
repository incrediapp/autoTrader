import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class EarningsEventModel {
  final String symbol;
  final DateTime? earningsDate;
  final String? fiscalQuarter;
  final double? estimatedEps;
  final double? actualEps;
  final String? reportTime;

  const EarningsEventModel({
    required this.symbol,
    this.earningsDate,
    this.fiscalQuarter,
    this.estimatedEps,
    this.actualEps,
    this.reportTime,
  });

  String get docId =>
      '${symbol}_${earningsDate?.toIso8601String().split('T').first ?? 'unknown'}';

  factory EarningsEventModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return EarningsEventModel.fromJson(data);
  }

  factory EarningsEventModel.fromJson(Map<String, dynamic> json) {
    return EarningsEventModel(
      symbol: json['symbol']?.toString() ?? '',
      earningsDate: parseTimestamp(json['earningsDate']),
      fiscalQuarter: json['fiscalQuarter']?.toString(),
      estimatedEps: json['estimatedEPS'] != null || json['estimatedEps'] != null
          ? parseDouble(json['estimatedEPS'] ?? json['estimatedEps'])
          : null,
      actualEps: json['actualEPS'] != null || json['actualEps'] != null
          ? parseDouble(json['actualEPS'] ?? json['actualEps'])
          : null,
      reportTime: json['reportTime']?.toString(),
    );
  }
}
