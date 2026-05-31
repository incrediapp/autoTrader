import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/providers/cloud_functions_provider.dart';
class AdminTransactionsScreen extends ConsumerStatefulWidget {
  const AdminTransactionsScreen({super.key});

  @override
  ConsumerState<AdminTransactionsScreen> createState() =>
      _AdminTransactionsScreenState();
}

class _AdminTransactionsScreenState extends ConsumerState<AdminTransactionsScreen> {
  List<Map<String, dynamic>> _rows = [];
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final result = await ref.read(cloudFunctionsProvider).getAdminTransactions({});
      final rows = result['transactions'] as List<dynamic>? ?? [];
      setState(() {
        _rows = rows.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _export() async {
    final result = await ref.read(cloudFunctionsProvider).generateTradeExport();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Export URL: ${result['url'] ?? 'pending'}')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(
              children: [
                FilledButton(onPressed: _load, child: const Text('Refresh')),
                const SizedBox(width: 8),
                OutlinedButton(onPressed: _export, child: const Text('Export CSV')),
              ],
            ),
          ),
          Expanded(
            child: _rows.isEmpty
                ? const Center(child: Text('No transactions'))
                : SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      columns: const [
                        DataColumn(label: Text('User')),
                        DataColumn(label: Text('Strategy')),
                        DataColumn(label: Text('Asset')),
                        DataColumn(label: Text('Side')),
                        DataColumn(label: Text('Mode')),
                        DataColumn(label: Text('P&L')),
                      ],
                      rows: _rows
                          .map(
                            (r) => DataRow(cells: [
                              DataCell(Text(r['userEmail']?.toString() ?? '')),
                              DataCell(Text(r['strategyName']?.toString() ?? '')),
                              DataCell(Text(r['symbol']?.toString() ?? '')),
                              DataCell(Text(r['side']?.toString() ?? '')),
                              DataCell(Text(r['mode']?.toString() ?? '')),
                              DataCell(Text(r['realizedPnlUsd']?.toString() ?? '')),
                            ]),
                          )
                          .toList(),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
