import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          ListTile(
            leading: const Icon(Icons.link),
            title: const Text('Broker connections'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/settings/brokers'),
          ),
          ListTile(
            leading: const Icon(Icons.notifications_outlined),
            title: const Text('Notifications'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/settings/notifications'),
          ),
          ListTile(
            leading: const Icon(Icons.person_outline),
            title: const Text('Account'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/settings/account'),
          ),
          ListTile(
            leading: const Icon(Icons.merge_type),
            title: const Text('Conflict log'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/settings/conflicts'),
          ),
        ],
      ),
    );
  }
}
