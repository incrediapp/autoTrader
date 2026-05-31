import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/error_log_model.dart';
import '../models/system_metrics.dart';
import '../models/user_model.dart';

final systemMetricsProvider = StreamProvider<SystemMetrics>((ref) {
  return FirebaseFirestore.instance
      .doc('systemMetrics/current')
      .snapshots()
      .map((s) => s.exists
          ? SystemMetrics.fromDoc(s)
          : const SystemMetrics());
});

final adminUsersProvider = StreamProvider<List<UserModel>>((ref) {
  return FirebaseFirestore.instance
      .collection('users')
      .orderBy('createdAt', descending: true)
      .snapshots()
      .map((s) => s.docs.map(UserModel.fromDoc).toList());
});

final adminErrorsProvider = StreamProvider<List<ErrorLogModel>>((ref) {
  return FirebaseFirestore.instance
      .collection('errorLogs')
      .orderBy('occurredAt', descending: true)
      .limit(100)
      .snapshots()
      .map((s) => s.docs.map(ErrorLogModel.fromDoc).toList());
});

final adminAuditLogProvider =
    StreamProvider<List<Map<String, dynamic>>>((ref) {
  return FirebaseFirestore.instance
      .collection('adminAuditLog')
      .orderBy('performedAt', descending: true)
      .limit(100)
      .snapshots()
      .map((s) => s.docs.map((d) => {...d.data(), 'auditId': d.id}).toList());
});

final macroEventsProvider = StreamProvider<List<Map<String, dynamic>>>((ref) {
  final now = DateTime.now();
  final twoWeeks = now.add(const Duration(days: 14));
  return FirebaseFirestore.instance
      .collection('macroCalendar')
      .where('eventDate', isGreaterThanOrEqualTo: Timestamp.fromDate(now))
      .where('eventDate', isLessThanOrEqualTo: Timestamp.fromDate(twoWeeks))
      .orderBy('eventDate')
      .snapshots()
      .map((s) => s.docs.map((d) => {...d.data(), 'eventId': d.id}).toList());
});

final earningsCalendarProvider =
    StreamProvider.family<List<Map<String, dynamic>>, List<String>>(
        (ref, symbols) {
  if (symbols.isEmpty) return Stream.value([]);
  final now = DateTime.now();
  final future = now.add(const Duration(days: 14));
  return FirebaseFirestore.instance
      .collection('earningsCalendar')
      .where('symbol', whereIn: symbols.length > 10 ? symbols.sublist(0, 10) : symbols)
      .where('earningsDate', isGreaterThanOrEqualTo: Timestamp.fromDate(now))
      .where('earningsDate', isLessThanOrEqualTo: Timestamp.fromDate(future))
      .orderBy('earningsDate')
      .snapshots()
      .map((s) => s.docs.map((d) => d.data()).toList());
});

final conflictLogsProvider =
    StreamProvider.family<List<Map<String, dynamic>>, String>((ref, userId) {
  return FirebaseFirestore.instance
      .collection('users/$userId/conflictLogs')
      .orderBy('detectedAt', descending: true)
      .limit(50)
      .snapshots()
      .map((s) => s.docs.map((d) => {...d.data(), 'conflictId': d.id}).toList());
});

final replaySessionsProvider =
    StreamProvider.family<List<Map<String, dynamic>>, String>((ref, strategyId) {
  return Stream.value([]);
});
