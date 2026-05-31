import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../shared/providers/admin_provider.dart';

class AdminAuditLogScreen extends ConsumerWidget {
  const AdminAuditLogScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final audit = ref.watch(adminAuditLogProvider);

    return audit.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) {
          final a = list[i];
          final at = a['performedAt'];
          DateTime? when;
          if (at != null) {
            when = at is DateTime
                ? at
                : at is Timestamp
                    ? at.toDate()
                    : null;
          }
          return ListTile(
            title: Text('${a['action']} → ${a['targetType']}'),
            subtitle: Text(
              '${a['adminEmail'] ?? a['adminUserId']} · ${when != null ? timeago.format(when) : ''}',
            ),
          );
        },
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
    );
  }
}
