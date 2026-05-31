import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../shared/providers/auth_provider.dart';
import '../../shared/providers/user_provider.dart';

class AccountSettingsScreen extends ConsumerWidget {
  const AccountSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider).valueOrNull;
    final auth = FirebaseAuth.instance.currentUser;

    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: ListView(
        children: [
          ListTile(
            title: const Text('Display name'),
            subtitle: Text(user?.displayName ?? auth?.displayName ?? ''),
          ),
          ListTile(
            title: const Text('Email'),
            subtitle: Text(user?.email ?? auth?.email ?? ''),
          ),
          ListTile(
            title: const Text('Role'),
            subtitle: Text(user?.role ?? 'user'),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.logout, color: Colors.red),
            title: const Text('Sign out'),
            onTap: () async {
              await ref.read(authRepositoryProvider).signOut();
              if (context.mounted) context.go('/auth');
            },
          ),
        ],
      ),
    );
  }
}
