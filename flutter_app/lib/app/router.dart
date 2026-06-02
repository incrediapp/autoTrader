import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/admin/admin_audit_log_screen.dart';
import '../features/admin/admin_error_log_screen.dart';
import '../features/admin/admin_overview_screen.dart';
import '../features/admin/admin_transactions_screen.dart';
import '../features/admin/admin_user_detail_screen.dart';
import '../features/admin/admin_users_screen.dart';
import '../features/analytics/analytics_dashboard_screen.dart';
import '../features/auth/auth_screen.dart';
import '../features/auth/bootstrap_screen.dart';
import '../features/calendar/macro_calendar_screen.dart';
import '../features/dashboard/strategies_overview_screen.dart';
import '../features/notifications/notification_history_screen.dart';
import '../features/onboarding/onboarding_flow.dart';
import '../features/settings/account_settings_screen.dart';
import '../features/settings/broker_connections_screen.dart';
import '../features/settings/conflict_log_screen.dart';
import '../features/settings/notification_settings_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/strategy/cycle_detail_screen.dart';
import '../features/strategy/live_signals_screen.dart';
import '../features/strategy/monte_carlo_screen.dart';
import '../features/strategy/new_strategy_flow.dart';
import '../features/strategy/replay_screen.dart';
import '../features/strategy/strategy_detail_screen.dart';
import '../features/strategy/trade_detail_screen.dart';
import '../shared/providers/auth_provider.dart';
import '../shared/providers/user_provider.dart';
import '../shared/widgets/admin_shell.dart';
import '../shared/widgets/user_shell.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _shellNavigatorKey = GlobalKey<NavigatorState>();

class _RouterRefreshNotifier extends ChangeNotifier {
  void refresh() => notifyListeners();
}

bool _onboardingAllowedLocation(String loc) {
  return loc.startsWith('/onboarding') ||
      loc == '/dashboard/new-strategy' ||
      loc.startsWith('/dashboard/strategy/');
}

User? _currentAuthUser(Ref ref) {
  final authState = ref.read(authStateProvider);
  return authState.valueOrNull ?? FirebaseAuth.instance.currentUser;
}

String? _resolveRedirect(Ref ref, GoRouterState state) {
  final authState = ref.read(authStateProvider);
  final userState = ref.read(userProvider);
  final loc = state.matchedLocation;

  // Wait for the auth stream's first emission (after main() ensureInitialized).
  if (!authState.hasValue) {
    return loc == '/bootstrap' ? null : '/bootstrap';
  }

  final authUser = _currentAuthUser(ref);
  if (authUser == null) {
    return loc == '/auth' ? null : '/auth';
  }

  if (userState.isLoading) {
    return loc == '/bootstrap' ? null : '/bootstrap';
  }

  final user = userState.valueOrNull;
  final isAdmin = user?.isAdmin ?? false;

  if (user != null &&
      !user.onboarding.isComplete &&
      !_onboardingAllowedLocation(loc)) {
    return '/onboarding';
  }

  if (loc == '/bootstrap' || loc == '/auth') {
    return '/dashboard';
  }

  if (loc.startsWith('/admin') && !isAdmin) {
    return '/dashboard';
  }

  return null;
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefreshNotifier();

  ref.listen(authStateProvider, (_, __) => refresh.refresh());
  ref.listen(userProvider, (_, __) => refresh.refresh());
  ref.onDispose(refresh.dispose);

  final router = GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/bootstrap',
    refreshListenable: refresh,
    redirect: (context, state) => _resolveRedirect(ref, state),
    routes: [
      GoRoute(
        path: '/bootstrap',
        builder: (_, __) => const BootstrapScreen(),
      ),
      GoRoute(
        path: '/auth',
        builder: (_, __) => const AuthScreen(),
      ),
      GoRoute(
        path: '/onboarding',
        builder: (_, __) => const OnboardingFlow(),
      ),
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (_, state, child) => UserShell(child: child),
        routes: [
          GoRoute(
            path: '/dashboard',
            builder: (_, __) => const StrategiesOverviewScreen(),
            routes: [
              GoRoute(
                path: 'new-strategy',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (_, __) => const NewStrategyFlow(),
              ),
              GoRoute(
                path: 'strategy/:id',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (_, state) => StrategyDetailScreen(
                  strategyId: state.pathParameters['id']!,
                ),
                routes: [
                  GoRoute(
                    path: 'live-signals',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (_, state) => LiveSignalsScreen(
                      strategyId: state.pathParameters['id']!,
                    ),
                  ),
                  GoRoute(
                    path: 'monte-carlo',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (_, state) => MonteCarloScreen(
                      strategyId: state.pathParameters['id']!,
                    ),
                  ),
                  GoRoute(
                    path: 'replay',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (_, state) => ReplayScreen(
                      strategyId: state.pathParameters['id']!,
                    ),
                  ),
                  GoRoute(
                    path: 'cycle/:cycleId',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (_, state) => CycleDetailScreen(
                      strategyId: state.pathParameters['id']!,
                      cycleId: state.pathParameters['cycleId']!,
                    ),
                  ),
                  GoRoute(
                    path: 'trade/:tradeId',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (_, state) => TradeDetailScreen(
                      strategyId: state.pathParameters['id']!,
                      tradeId: state.pathParameters['tradeId']!,
                    ),
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: '/analytics',
            builder: (_, __) => const AnalyticsDashboardScreen(),
          ),
          GoRoute(
            path: '/calendar',
            builder: (_, __) => const MacroCalendarScreen(),
          ),
          GoRoute(
            path: '/notifications',
            builder: (_, __) => const NotificationHistoryScreen(),
          ),
          GoRoute(
            path: '/settings',
            builder: (_, __) => const SettingsScreen(),
            routes: [
              GoRoute(
                path: 'brokers',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (_, __) => const BrokerConnectionsScreen(),
              ),
              GoRoute(
                path: 'notifications',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (_, __) => const NotificationSettingsScreen(),
              ),
              GoRoute(
                path: 'account',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (_, __) => const AccountSettingsScreen(),
              ),
              GoRoute(
                path: 'conflicts',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (_, __) => const ConflictLogScreen(),
              ),
            ],
          ),
        ],
      ),
      ShellRoute(
        builder: (_, __, child) => AdminShell(child: child),
        routes: [
          GoRoute(
            path: '/admin',
            builder: (_, __) => const AdminOverviewScreen(),
          ),
          GoRoute(
            path: '/admin/users',
            builder: (_, __) => const AdminUsersScreen(),
            routes: [
              GoRoute(
                path: ':userId',
                builder: (_, state) => AdminUserDetailScreen(
                  userId: state.pathParameters['userId']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/admin/transactions',
            builder: (_, __) => const AdminTransactionsScreen(),
          ),
          GoRoute(
            path: '/admin/errors',
            builder: (_, __) => const AdminErrorLogScreen(),
          ),
          GoRoute(
            path: '/admin/audit',
            builder: (_, __) => const AdminAuditLogScreen(),
          ),
        ],
      ),
    ],
  );

  ref.onDispose(router.dispose);
  return router;
});
