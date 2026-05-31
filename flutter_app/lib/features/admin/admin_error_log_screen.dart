import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../app/app_colors.dart';
import '../../shared/providers/admin_provider.dart';

class AdminErrorLogScreen extends ConsumerWidget {
  const AdminErrorLogScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final errors = ref.watch(adminErrorsProvider);

    return errors.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) {
          final e = list[i];
          final color = switch (e.severity) {
            'critical' => AppColors.critical,
            'warning' => AppColors.warning,
            _ => Colors.red,
          };
          return Card(
            margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: ExpansionTile(
              leading: Icon(Icons.error, color: color),
              title: Text(e.message, maxLines: 2, overflow: TextOverflow.ellipsis),
              subtitle: Text(
                '${e.source} · ${e.occurredAt != null ? timeago.format(e.occurredAt!) : ''}',
              ),
              children: [
                if (!e.resolved)
                  TextButton(
                    onPressed: () async {
                      await FirebaseFirestore.instance
                          .doc('errorLogs/${e.errorId}')
                          .update({'resolved': true});
                    },
                    child: const Text('Mark resolved'),
                  ),
              ],
            ),
          );
        },
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
    );
  }
}
