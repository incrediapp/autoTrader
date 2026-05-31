import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app/router.dart';
import 'app/theme.dart';
import 'firebase_options.dart';
import 'repositories/auth_repository.dart';
import 'shared/providers/auth_provider.dart';
import 'shared/providers/cloud_functions_provider.dart';

@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await AuthRepository.ensureInitialized(FirebaseAuth.instance);
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
  runApp(const ProviderScope(child: AiTraderApp()));
}

class AiTraderApp extends ConsumerStatefulWidget {
  const AiTraderApp({super.key});

  @override
  ConsumerState<AiTraderApp> createState() => _AiTraderAppState();
}

class _AiTraderAppState extends ConsumerState<AiTraderApp> {
  String? _profileEnsuredForUid;

  @override
  void initState() {
    super.initState();
    _setupFcm();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _ensureProfileForCurrentUser();
    });
  }

  Future<void> _ensureProfileForCurrentUser() async {
    final user = ref.read(authStateProvider).valueOrNull ??
        ref.read(authRepositoryProvider).currentUser;
    if (user == null || _profileEnsuredForUid == user.uid) return;
    _profileEnsuredForUid = user.uid;
    try {
      await ref.read(cloudFunctionsProvider).createUserProfile(
            displayName: user.displayName?.trim().isNotEmpty == true
                ? user.displayName!.trim()
                : (user.isAnonymous ? 'Guest' : 'User'),
            email: user.email ?? '',
            photoUrl: user.photoURL,
          );
    } catch (_) {}
  }

  Future<void> _setupFcm() async {
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);

    final token = await messaging.getToken();
    if (token != null) {
      try {
        await ref.read(cloudFunctionsProvider).updateFcmToken(token);
      } catch (_) {}
    }

    messaging.onTokenRefresh.listen((newToken) async {
      try {
        await ref.read(cloudFunctionsProvider).updateFcmToken(newToken);
      } catch (_) {}
    });

    FirebaseMessaging.onMessage.listen((message) {
      if (!mounted) return;
      final notification = message.notification;
      if (notification == null) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(notification.title ?? notification.body ?? 'Notification'),
          action: SnackBarAction(
            label: 'View',
            onPressed: () => _handleNotificationNavigation(message.data),
          ),
        ),
      );
    });

    FirebaseMessaging.onMessageOpenedApp.listen((message) {
      _handleNotificationNavigation(message.data);
    });

    final initial = await messaging.getInitialMessage();
    if (initial != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _handleNotificationNavigation(initial.data);
      });
    }
  }

  void _handleNotificationNavigation(Map<String, dynamic> data) {
    final router = ref.read(routerProvider);
    switch (data['type']) {
      case 'trade_executed':
        final strategyId = data['strategyId']?.toString();
        final tradeId = data['tradeId']?.toString();
        if (strategyId != null && tradeId != null) {
          router.go('/dashboard/strategy/$strategyId/trade/$tradeId');
        }
        break;
      case 'cycle_complete':
      case 'drawdown_limit_hit':
        final strategyId = data['strategyId']?.toString();
        if (strategyId != null) {
          router.go('/dashboard/strategy/$strategyId');
        }
        break;
      default:
        router.go('/notifications');
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(authStateProvider, (previous, next) {
      final user = next.valueOrNull;
      if (user == null) {
        _profileEnsuredForUid = null;
        return;
      }
      if (_profileEnsuredForUid != user.uid) {
        _ensureProfileForCurrentUser();
      }
    });

    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'AI Auto Trader',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.dark,
      routerConfig: router,
    );
  }
}
