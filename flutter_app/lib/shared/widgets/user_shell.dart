import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/breakpoints.dart';
import '../providers/user_provider.dart';

class UserShell extends ConsumerWidget {
  const UserShell({super.key, required this.child});

  final Widget child;

  static const _destinations = [
    (icon: Icons.dashboard_outlined, selected: Icons.dashboard, label: 'Strategies', path: '/dashboard'),
    (icon: Icons.analytics_outlined, selected: Icons.analytics, label: 'Analytics', path: '/analytics'),
    (icon: Icons.calendar_month_outlined, selected: Icons.calendar_month, label: 'Macro', path: '/calendar'),
    (icon: Icons.notifications_outlined, selected: Icons.notifications, label: 'Alerts', path: '/notifications'),
    (icon: Icons.settings_outlined, selected: Icons.settings, label: 'Settings', path: '/settings'),
  ];

  int _selectedIndex(String location) {
    if (location.startsWith('/analytics')) return 1;
    if (location.startsWith('/calendar')) return 2;
    if (location.startsWith('/notifications')) return 3;
    if (location.startsWith('/settings')) return 4;
    return 0;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final location = GoRouterState.of(context).uri.toString();
    final user = ref.watch(userProvider).valueOrNull;
    final width = MediaQuery.sizeOf(context).width;
    final selected = _selectedIndex(location);

    void onSelect(int i) {
      if (user?.isAdmin == true && i == _destinations.length) {
        context.go('/admin');
        return;
      }
      if (i < _destinations.length) {
        context.go(_destinations[i].path);
      }
    }

    if (isWide(width)) {
      final drawerDestinations = [
        ..._destinations.map(
          (d) => NavigationDrawerDestination(
            icon: Icon(d.icon),
            selectedIcon: Icon(d.selected),
            label: Text(d.label),
          ),
        ),
        if (user?.isAdmin == true)
          const NavigationDrawerDestination(
            icon: Icon(Icons.admin_panel_settings_outlined),
            selectedIcon: Icon(Icons.admin_panel_settings),
            label: Text('Admin'),
          ),
      ];
      return Scaffold(
        body: Row(
          children: [
            NavigationDrawer(
              selectedIndex: location.startsWith('/admin')
                  ? drawerDestinations.length - 1
                  : selected,
              onDestinationSelected: onSelect,
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'AI Auto Trader',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                ...drawerDestinations,
              ],
            ),
            Expanded(child: child),
          ],
        ),
      );
    }

    if (isTablet(width)) {
      return Scaffold(
        body: Row(
          children: [
            NavigationRail(
              selectedIndex: selected,
              onDestinationSelected: onSelect,
              labelType: NavigationRailLabelType.all,
              destinations: _destinations
                  .map(
                    (d) => NavigationRailDestination(
                      icon: Icon(d.icon),
                      selectedIcon: Icon(d.selected),
                      label: Text(d.label),
                    ),
                  )
                  .toList(),
            ),
            Expanded(child: child),
          ],
        ),
      );
    }

    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: selected,
        onDestinationSelected: onSelect,
        destinations: _destinations
            .map(
              (d) => NavigationDestination(
                icon: Icon(d.icon),
                selectedIcon: Icon(d.selected),
                label: d.label,
              ),
            )
            .toList(),
      ),
    );
  }
}
