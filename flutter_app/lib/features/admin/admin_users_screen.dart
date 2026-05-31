import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../shared/providers/admin_provider.dart';
import '../../shared/widgets/error_state.dart';

class AdminUsersScreen extends ConsumerStatefulWidget {
  const AdminUsersScreen({super.key});

  @override
  ConsumerState<AdminUsersScreen> createState() => _AdminUsersScreenState();
}

class _AdminUsersScreenState extends ConsumerState<AdminUsersScreen> {
  String _query = '';
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final users = ref.watch(adminUsersProvider);

    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Search by email or name…',
                prefixIcon: Icon(Icons.search),
              ),
              onChanged: (v) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 300), () {
                  setState(() => _query = v.toLowerCase());
                });
              },
            ),
          ),
          Expanded(
            child: users.when(
              data: (list) {
                final filtered = _query.isEmpty
                    ? list
                    : list.where((u) {
                        return u.email.toLowerCase().contains(_query) ||
                            u.displayName.toLowerCase().contains(_query);
                      }).toList();
                return ListView.builder(
                  itemCount: filtered.length,
                  itemBuilder: (_, i) {
                    final u = filtered[i];
                    return ListTile(
                      title: Text(u.displayName),
                      subtitle: Text(
                        '${u.email} · ${u.lastActiveAt != null ? timeago.format(u.lastActiveAt!) : '—'}',
                      ),
                      trailing: Chip(label: Text(u.status)),
                      onTap: () => context.go('/admin/users/${u.uid}'),
                    );
                  },
                );
              },
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => ErrorState(
                error: e,
                onRetry: () => ref.invalidate(adminUsersProvider),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
