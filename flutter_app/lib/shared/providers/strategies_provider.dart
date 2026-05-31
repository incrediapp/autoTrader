import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/autopilot_report_model.dart';
import '../models/position_model.dart';
import '../models/shadow_config_model.dart';
import '../models/strategy_model.dart';
import 'user_provider.dart';

final strategiesProvider = StreamProvider<List<StrategyModel>>((ref) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
      .collection('users/${user.uid}/strategies')
      .orderBy('createdAt', descending: true)
      .snapshots()
      .map(
        (s) => s.docs
            .map(StrategyModel.fromDoc)
            .where((strategy) => strategy.status != 'archived')
            .toList(),
      );
});

final strategyProvider =
    StreamProvider.family<StrategyModel?, String>((ref, id) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value(null);
  return FirebaseFirestore.instance
      .doc('users/${user.uid}/strategies/$id')
      .snapshots()
      .map((s) => s.exists ? StrategyModel.fromDoc(s) : null);
});

final positionsProvider =
    StreamProvider.family<List<PositionModel>, String>((ref, strategyId) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
      .collection('users/${user.uid}/strategies/$strategyId/positions')
      .snapshots()
      .map((s) => s.docs.map(PositionModel.fromDoc).toList());
});

final shadowConfigsProvider =
    StreamProvider.family<List<ShadowConfigModel>, String>((ref, strategyId) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
      .collection(
          'users/${user.uid}/strategies/$strategyId/shadowConfigs')
      .where('status', isEqualTo: 'active')
      .snapshots()
      .map((s) => s.docs.map(ShadowConfigModel.fromDoc).toList());
});

final autopilotReportsProvider =
    StreamProvider.family<List<AutopilotReportModel>, String>((ref, strategyId) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
      .collection(
          'users/${user.uid}/strategies/$strategyId/autopilotReports')
      .orderBy('generatedAt', descending: true)
      .limit(5)
      .snapshots()
      .map((s) => s.docs.map(AutopilotReportModel.fromDoc).toList());
});

final pendingAutopilotProvider =
    Provider.family<AutopilotReportModel?, String>((ref, strategyId) {
  final reports = ref.watch(autopilotReportsProvider(strategyId)).valueOrNull;
  return reports?.where((r) => r.isPending).firstOrNull;
});
