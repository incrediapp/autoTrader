import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/breakpoints.dart';

class AdminShell extends StatelessWidget {
  const AdminShell({super.key, required this.child});

  final Widget child;

  static const _routes = [
    ('Overview', '/admin'),
    ('Users', '/admin/users'),
    ('Transactions', '/admin/transactions'),
    ('Errors', '/admin/errors'),
    ('Audit', '/admin/audit'),
  ];

  int _index(String location) {
    if (location.startsWith('/admin/users')) return 1;
    if (location.startsWith('/admin/transactions')) return 2;
    if (location.startsWith('/admin/errors')) return 3;
    if (location.startsWith('/admin/audit')) return 4;
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).uri.toString();
    final selected = _index(location);
    final width = MediaQuery.sizeOf(context).width;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/dashboard'),
        ),
      ),
      body: Row(
        children: [
          if (isTablet(width))
            NavigationRail(
              selectedIndex: selected,
              onDestinationSelected: (i) => context.go(_routes[i].$2),
              labelType: NavigationRailLabelType.all,
              destinations: _routes
                  .map(
                    (r) => NavigationRailDestination(
                      icon: const Icon(Icons.circle_outlined),
                      selectedIcon: const Icon(Icons.circle),
                      label: Text(r.$1),
                    ),
                  )
                  .toList(),
            ),
          Expanded(child: child),
        ],
      ),
    );
  }
}
