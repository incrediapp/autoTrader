import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../shared/models/conflict_log_model.dart';
import '../../shared/providers/admin_provider.dart';
import '../../shared/providers/user_provider.dart';
import '../strategy/conflict_resolution_sheet.dart';

class ConflictLogScreen extends ConsumerWidget {
  const ConflictLogScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userId = ref.watch(userIdProvider);
    if (userId == null) {
      return const Scaffold(body: Center(child: Text('Not signed in')));
    }

    final logs = ref.watch(conflictLogsProvider(userId));

    return Scaffold(
      appBar: AppBar(title: const Text('Conflict log')),
      body: logs.when(
        data: (list) => list.isEmpty
            ? const Center(child: Text('No conflicts recorded'))
            : ListView.builder(
                itemCount: list.length,
                itemBuilder: (_, i) {
                  final c = ConflictLogModel.fromJson(list[i], id: list[i]['conflictId']?.toString());
                  return ListTile(
                    title: Text('${c.symbol} — ${c.resolution}'),
                    subtitle: Text(
                      '${c.strategyAName} vs ${c.strategyBName} · ${c.detectedAt != null ? timeago.format(c.detectedAt!) : ''}',
                    ),
                    onTap: () => showConflictResolutionSheet(context, ref, c),
                  );
                },
              ),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
      ),
    );
  }
}
