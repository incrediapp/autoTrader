import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class ErrorLogModel {
  final String errorId;
  final String? userId;
  final String? strategyId;
  final String source;
  final String severity;
  final String message;
  final String? errorCode;
  final DateTime? occurredAt;
  final bool resolved;
  final String? resolutionNote;

  const ErrorLogModel({
    required this.errorId,
    this.userId,
    this.strategyId,
    this.source = 'unknown',
    this.severity = 'error',
    required this.message,
    this.errorCode,
    this.occurredAt,
    this.resolved = false,
    this.resolutionNote,
  });

  factory ErrorLogModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return ErrorLogModel.fromJson(data, id: doc.id);
  }

  factory ErrorLogModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return ErrorLogModel(
      errorId: id ?? json['errorId']?.toString() ?? '',
      userId: json['userId']?.toString(),
      strategyId: json['strategyId']?.toString(),
      source: json['source']?.toString() ?? 'unknown',
      severity: json['severity']?.toString() ?? 'error',
      message: json['message']?.toString() ?? '',
      errorCode: json['errorCode']?.toString(),
      occurredAt: parseTimestamp(json['occurredAt']),
      resolved: parseBool(json['resolved']),
      resolutionNote: json['resolutionNote']?.toString(),
    );
  }
}
