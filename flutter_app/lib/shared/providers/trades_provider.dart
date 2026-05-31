import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/trade_model.dart';
import 'user_provider.dart';

class TradeQuery {
  final String strategyId;
  final String? mode;
  final int? limit;

  const TradeQuery({
    required this.strategyId,
    this.mode,
    this.limit,
  });

  @override
  bool operator ==(Object other) =>
      other is TradeQuery &&
      other.strategyId == strategyId &&
      other.mode == mode &&
      other.limit == limit;

  @override
  int get hashCode => Object.hash(strategyId, mode, limit);
}

final tradesFeedProvider =
    StreamProvider.family<List<TradeModel>, TradeQuery>((ref, query) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value([]);
  Query<Map<String, dynamic>> q = FirebaseFirestore.instance
      .collection(
          'users/${user.uid}/strategies/${query.strategyId}/trades');
  if (query.mode != null) {
    q = q.where('mode', isEqualTo: query.mode);
  }
  q = q.orderBy('executedAt', descending: true);
  return q
      .limit(query.limit ?? 50)
      .snapshots()
      .map((s) => s.docs.map(TradeModel.fromDoc).toList());
});

final tradeProvider = StreamProvider.family<TradeModel?, TradeKey>((ref, key) {
  final user = ref.watch(userProvider).valueOrNull;
  if (user == null) return Stream.value(null);
  return FirebaseFirestore.instance
      .doc(
          'users/${user.uid}/strategies/${key.strategyId}/trades/${key.tradeId}')
      .snapshots()
      .map((s) => s.exists ? TradeModel.fromDoc(s) : null);
});

class TradeKey {
  final String strategyId;
  final String tradeId;

  const TradeKey({required this.strategyId, required this.tradeId});

  @override
  bool operator ==(Object other) =>
      other is TradeKey &&
      other.strategyId == strategyId &&
      other.tradeId == tradeId;

  @override
  int get hashCode => Object.hash(strategyId, tradeId);
}
