import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/cycle_model.dart';
import 'user_provider.dart';

final cyclesFeedProvider =
    StreamProvider.family<List<CycleModel>, String>((ref, strategyId) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
      .collection('users/${user.uid}/strategies/$strategyId/cycles')
      .orderBy('startedAt', descending: true)
      .limit(50)
      .snapshots()
      .map((s) => s.docs.map(CycleModel.fromDoc).toList());
});

final latestCycleProvider =
    StreamProvider.family<CycleModel?, String>((ref, strategyId) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value(null);
  return FirebaseFirestore.instance
      .collection('users/${user.uid}/strategies/$strategyId/cycles')
      .orderBy('startedAt', descending: true)
      .limit(1)
      .snapshots()
      .map((s) => s.docs.isNotEmpty ? CycleModel.fromDoc(s.docs.first) : null);
});

final cycleProvider = StreamProvider.family<CycleModel?, CycleKey>((ref, key) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value(null);
  return FirebaseFirestore.instance
      .doc(
          'users/${user.uid}/strategies/${key.strategyId}/cycles/${key.cycleId}')
      .snapshots()
      .map((s) => s.exists ? CycleModel.fromDoc(s) : null);
});

class CycleKey {
  final String strategyId;
  final String cycleId;

  const CycleKey({required this.strategyId, required this.cycleId});

  @override
  bool operator ==(Object other) =>
      other is CycleKey &&
      other.strategyId == strategyId &&
      other.cycleId == cycleId;

  @override
  int get hashCode => Object.hash(strategyId, cycleId);
}
