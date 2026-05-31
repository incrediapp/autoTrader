import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/providers/admin_provider.dart';
import '../../shared/providers/cloud_functions_provider.dart';

class AdminUserDetailScreen extends ConsumerWidget {
  const AdminUserDetailScreen({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(adminUsersProvider);

    return users.when(
      data: (list) {
        final user = list.where((u) => u.uid == userId).firstOrNull;
        if (user == null) {
          return const Scaffold(body: Center(child: Text('User not found')));
        }
        return DefaultTabController(
          length: 4,
          child: Scaffold(
            appBar: AppBar(
              title: Text(user.displayName),
              bottom: const TabBar(
                tabs: [
                  Tab(text: 'Profile'),
                  Tab(text: 'Strategies'),
                  Tab(text: 'Errors'),
                  Tab(text: 'Actions'),
                ],
              ),
            ),
            body: TabBarView(
              children: [
                ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    ListTile(title: const Text('Email'), subtitle: Text(user.email)),
                    ListTile(title: const Text('Status'), subtitle: Text(user.status)),
                    ListTile(
                      title: const Text('Strategies'),
                      subtitle: Text('${user.stats.totalStrategies} total'),
                    ),
                    ListTile(
                      title: const Text('P&L'),
                      subtitle: Text('\$${user.stats.totalRealizedPnlUsd.toStringAsFixed(2)}'),
                    ),
                  ],
                ),
                const Center(child: Text('Strategies list via admin CF')),
                const Center(child: Text('User errors')),
                _AdminActions(userId: userId),
              ],
            ),
          ),
        );
      },
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (e, _) => Scaffold(body: Center(child: Text('$e'))),
    );
  }
}

class _AdminActions extends ConsumerWidget {
  const _AdminActions({required this.userId});

  final String userId;

  Future<void> _action(WidgetRef ref, String action) async {
    await ref.read(cloudFunctionsProvider).adminAction(
          action: action,
          targetUserId: userId,
        );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListView(
      children: [
        ListTile(
          title: const Text('Suspend user'),
          onTap: () => _action(ref, 'suspend_user'),
        ),
        ListTile(
          title: const Text('Reactivate user'),
          onTap: () => _action(ref, 'reactivate_user'),
        ),
        ListTile(
          title: const Text('Promote to admin'),
          onTap: () => _action(ref, 'promote_admin'),
        ),
      ],
    );
  }
}
