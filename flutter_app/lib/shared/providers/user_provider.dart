import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/user_model.dart';
import 'auth_provider.dart';

final userProvider = StreamProvider<UserModel?>((ref) {
  final auth = ref.watch(authStateProvider).valueOrNull;
  if (auth == null) return Stream.value(null);
  return FirebaseFirestore.instance
      .doc('users/${auth.uid}')
      .snapshots()
      .map((s) => s.exists ? UserModel.fromDoc(s) : null);
});

final userIdProvider = Provider<String?>((ref) {
  return ref.watch(userProvider).valueOrNull?.uid;
});
