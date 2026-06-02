import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../shared/models/macro_event_model.dart';
import '../../shared/providers/admin_provider.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/widgets/error_state.dart';

class MacroCalendarScreen extends ConsumerStatefulWidget {
  const MacroCalendarScreen({super.key});

  @override
  ConsumerState<MacroCalendarScreen> createState() => _MacroCalendarScreenState();
}

class _MacroCalendarScreenState extends ConsumerState<MacroCalendarScreen> {
  bool _refreshing = false;
  String? _refreshMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshIfNeeded());
  }

  Future<void> _refreshIfNeeded({bool force = false}) async {
    if (_refreshing) return;
    setState(() {
      _refreshing = true;
      _refreshMessage = null;
    });
    try {
      final result = await ref.read(cloudFunctionsProvider).refreshMacroCalendarNow();
      if (!mounted) return;
      final updated = result['updated'] as int? ?? 0;
      final skipped = result['skipped'] == true;
      final reason = result['reason']?.toString();
      setState(() {
        _refreshMessage = skipped
            ? (reason == 'no_api_key'
                ? 'Macro calendar API key not configured on server.'
                : 'Refresh skipped: ${reason ?? 'unknown'}')
            : 'Updated $updated events.';
      });
      if (force || skipped) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(_refreshMessage!)),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _refreshMessage = e.toString());
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Refresh failed: $e')),
      );
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final events = ref.watch(macroEventsProvider);
    final fmt = DateFormat.yMMMEd();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Macro Calendar'),
        actions: [
          if (_refreshing)
            const Padding(
              padding: EdgeInsets.all(16),
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else
            IconButton(
              tooltip: 'Refresh calendar',
              onPressed: () => _refreshIfNeeded(force: true),
              icon: const Icon(Icons.refresh),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _refreshIfNeeded(force: true),
        child: events.when(
          data: (list) {
            if (list.isEmpty) {
              return ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: [
                  const SizedBox(height: 120),
                  Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        children: [
                          const Text('No upcoming macro events'),
                          if (_refreshMessage != null) ...[
                            const SizedBox(height: 12),
                            Text(
                              _refreshMessage!,
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                          const SizedBox(height: 16),
                          FilledButton.icon(
                            onPressed: _refreshing ? null : () => _refreshIfNeeded(force: true),
                            icon: const Icon(Icons.cloud_download),
                            label: const Text('Load from server'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              );
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
              physics: const AlwaysScrollableScrollPhysics(),
              children: grouped.entries.map((entry) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                      child: Text(
                        entry.key,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    ...entry.value.map((e) => _EventTile(event: e)),
                  ],
                );
              }).toList(),
            );
          },
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorState(
            error: e,
            onRetry: () => _refreshIfNeeded(force: true),
          ),
        ),
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
          '${event.country} · ${event.eventTime ?? ''}\n'
          'Forecast: ${event.forecast ?? 'n/a'} · Previous: ${event.previous ?? 'n/a'}',
        ),
        isThreeLine: true,
      ),
    );
  }
}
