import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../services/cloud_functions.dart';
import '../../shared/providers/auth_provider.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/user_provider.dart';

class AccountSettingsScreen extends ConsumerStatefulWidget {
  const AccountSettingsScreen({super.key});

  @override
  ConsumerState<AccountSettingsScreen> createState() => _AccountSettingsScreenState();
}

class _AccountSettingsScreenState extends ConsumerState<AccountSettingsScreen> {
  final _guestUidController = TextEditingController();
  bool _importing = false;

  @override
  void dispose() {
    _guestUidController.dispose();
    super.dispose();
  }

  Future<void> _importGuestStrategies() async {
    final sourceUserId = _guestUidController.text.trim();
    if (sourceUserId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter your previous guest user ID')),
      );
      return;
    }

    setState(() => _importing = true);
    try {
      final result = await ref.read(cloudFunctionsProvider).migrateGuestStrategies(
            sourceUserId: sourceUserId,
            withHistory: true,
          );
      final copied = result['copied'];
      final count = copied is List ? copied.length : 0;
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Imported $count strateg${count == 1 ? 'y' : 'ies'} from guest account')),
      );
      _guestUidController.clear();
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message, e.details))),
      );
    } finally {
      if (mounted) setState(() => _importing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(userProvider).valueOrNull;
    final auth = FirebaseAuth.instance.currentUser;

    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: ListView(
        padding: const EdgeInsets.all(16),
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
            title: const Text('User ID'),
            subtitle: SelectableText(auth?.uid ?? ''),
          ),
          ListTile(
            title: const Text('Role'),
            subtitle: Text(user?.role ?? 'user'),
          ),
          const Divider(),
          Text('Import guest strategies', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(
            'If you used Continue as Guest before signing up with email, paste the old guest user ID here to copy your strategies and paper history.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _guestUidController,
            decoration: const InputDecoration(
              labelText: 'Previous guest user ID',
              hintText: 'yppaUOX4g7Z87JlwXZsUL3n5rsx1',
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _importing ? null : _importGuestStrategies,
            icon: _importing
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.download),
            label: Text(_importing ? 'Importing…' : 'Import strategies'),
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
