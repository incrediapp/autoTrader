import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../shared/models/earnings_event_model.dart';
import '../../shared/providers/admin_provider.dart';

class EarningsCalendarWidget extends ConsumerWidget {
  const EarningsCalendarWidget({super.key, required this.symbols});

  final List<String> symbols;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (symbols.isEmpty) return const SizedBox.shrink();

    final events = ref.watch(earningsCalendarProvider(symbols));
    final fmt = DateFormat.MMMd();

    return events.when(
      data: (list) {
        if (list.isEmpty) return const SizedBox.shrink();
        return Card(
          margin: const EdgeInsets.only(bottom: 16),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Upcoming earnings', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 8),
                ...list.map((raw) {
                  final e = EarningsEventModel.fromJson(raw);
                  return ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(e.symbol),
                    subtitle: Text(
                      '${e.fiscalQuarter ?? ''} · ${e.earningsDate != null ? fmt.format(e.earningsDate!) : ''} ${e.reportTime ?? ''}',
                    ),
                    trailing: e.estimatedEps != null
                        ? Text('EPS est ${e.estimatedEps!.toStringAsFixed(2)}')
                        : null,
                  );
                }),
              ],
            ),
          ),
        );
      },
      loading: () => const LinearProgressIndicator(),
      error: (_, __) => const SizedBox.shrink(),
    );
  }
}
