import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../shared/models/macro_event_model.dart';
import '../../shared/providers/admin_provider.dart';

class MacroCalendarScreen extends ConsumerWidget {
  const MacroCalendarScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(macroEventsProvider);
    final fmt = DateFormat.yMMMEd();

    return Scaffold(
      appBar: AppBar(title: const Text('Macro Calendar')),
      body: events.when(
        data: (list) {
          if (list.isEmpty) {
            return const Center(child: Text('No upcoming macro events'));
          }
          final models = list
              .map((e) => MacroEventModel.fromJson(e, id: e['eventId']?.toString()))
              .toList();
          final grouped = <String, List<MacroEventModel>>{};
          for (final e in models) {
            final key = e.eventDate != null ? fmt.format(e.eventDate!) : 'Unknown';
            grouped.putIfAbsent(key, () => []).add(e);
          }
          return ListView(
            children: grouped.entries.map((entry) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                    child: Text(entry.key, style: Theme.of(context).textTheme.titleMedium),
                  ),
                  ...entry.value.map((e) => _EventTile(event: e)),
                ],
              );
            }).toList(),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
      ),
    );
  }
}

class _EventTile extends StatelessWidget {
  const _EventTile({required this.event});

  final MacroEventModel event;

  Color get _impactColor => switch (event.impact) {
        'high' => Colors.red,
        'medium' => Colors.amber,
        _ => Colors.green,
      };

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: ListTile(
        leading: Icon(Icons.circle, color: _impactColor, size: 12),
        title: Text(event.shortName.isNotEmpty ? event.shortName : event.eventName),
        subtitle: Text(
          '${event.country} · ${event.eventTime ?? ''}\nForecast: ${event.forecast ?? 'n/a'} · Previous: ${event.previous ?? 'n/a'}',
        ),
        isThreeLine: true,
      ),
    );
  }
}
