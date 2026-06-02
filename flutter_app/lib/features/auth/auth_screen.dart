import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../repositories/auth_repository.dart';
import '../../services/cloud_functions.dart';
import '../../shared/providers/auth_provider.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/widgets/google_sign_in_button.dart';

class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key});

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _displayName = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _loading = false;
  bool _signUp = false;

  @override
  void dispose() {
    _displayName.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Theme.of(context).colorScheme.error,
      ),
    );
  }

  String _authError(FirebaseAuthException e) => switch (e.code) {
        'user-not-found' => 'No account with this email',
        'wrong-password' => 'Incorrect password',
        'too-many-requests' => 'Too many attempts. Try again in a few minutes.',
        'email-already-in-use' => 'An account already exists with this email',
        'weak-password' => 'Password is too weak (minimum 8 characters)',
        'invalid-credential' => 'Invalid email or password',
        'operation-not-allowed' =>
            'This sign-in method is not enabled. Enable it in Firebase Console → Authentication.',
        'aborted-by-user' => 'Sign-in cancelled',
        _ => e.message ?? 'Authentication failed',
      };

  Future<void> _ensureProfile(User user) async {
    final displayName = user.displayName?.trim();
    final fallbackName = user.isAnonymous
        ? 'Guest'
        : (_signUp ? _displayName.text.trim() : '');
    await ref.read(cloudFunctionsProvider).createUserProfile(
          displayName: (displayName != null && displayName.isNotEmpty)
              ? displayName
              : fallbackName,
          email: user.email ?? _email.text.trim(),
          photoUrl: user.photoURL,
        );
  }

  Future<void> _finishSignInSuccess() async {
    final user = ref.read(authRepositoryProvider).currentUser;
    if (user == null) return;
    await user.reload();
    final refreshed = ref.read(authRepositoryProvider).currentUser;
    if (refreshed == null) return;
    await _ensureProfile(refreshed);
    if (!mounted) return;
    // Navigation is handled by router redirects once auth/user providers update.
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _loading = true);
    try {
      await action();
      await _finishSignInSuccess();
    } on FirebaseAuthException catch (e) {
      if (e.code == 'aborted-by-user') return;
      _showError(_authError(e));
    } on FirebaseFunctionsException catch (e) {
      _showError(friendlyCloudFunctionError(e.code, e.message));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _resetPassword() async {
    final email = TextEditingController(text: _email.text.trim());
    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Reset password'),
        content: TextField(
          controller: email,
          decoration: const InputDecoration(labelText: 'Email'),
          keyboardType: TextInputType.emailAddress,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () async {
              try {
                await ref
                    .read(authRepositoryProvider)
                    .sendPasswordResetEmail(email.text.trim());
                if (ctx.mounted) {
                  Navigator.pop(ctx);
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Reset email sent')),
                    );
                  }
                }
              } on FirebaseAuthException catch (e) {
                _showError(_authError(e));
              }
            },
            child: const Text('Send'),
          ),
        ],
      ),
    );
    email.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.read(authRepositoryProvider);
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            ListView(
              padding: const EdgeInsets.all(24),
              children: [
                const SizedBox(height: 32),
                Text(
                  'AI Auto Trader',
                  style: theme.textTheme.headlineMedium,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  'Sign in to manage your trading strategies',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                if (kDebugMode && kIsWeb)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Text(
                      'Dev tip: start with ./scripts/run-web.sh and use the Chrome '
                      'window it opens (http://localhost:7357). '
                      'Current origin: ${Uri.base.origin}. '
                      'Guest sessions do not carry over if you open a different browser or port.',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                GoogleSignInButton(
                  text: 'Continue with Google',
                  onPressed: _loading ? null : () => _run(auth.signInWithGoogle),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _loading ? null : () => _run(auth.signInAnonymously),
                  icon: const Icon(Icons.person_outline),
                  label: const Text('Continue as Guest'),
                ),
                const SizedBox(height: 24),
                Row(
                  children: [
                    const Expanded(child: Divider()),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      child: Text(
                        'or',
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                    const Expanded(child: Divider()),
                  ],
                ),
                const SizedBox(height: 24),
                Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (_signUp) ...[
                        TextFormField(
                          controller: _displayName,
                          decoration: const InputDecoration(labelText: 'Display name'),
                          textInputAction: TextInputAction.next,
                        ),
                        const SizedBox(height: 16),
                      ],
                      TextFormField(
                        controller: _email,
                        decoration: const InputDecoration(labelText: 'Email'),
                        keyboardType: TextInputType.emailAddress,
                        textInputAction: TextInputAction.next,
                        validator: (v) =>
                            v == null || !v.contains('@') ? 'Enter a valid email' : null,
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _password,
                        decoration: const InputDecoration(labelText: 'Password'),
                        obscureText: true,
                        textInputAction: TextInputAction.done,
                        validator: (v) {
                          if (v == null || v.isEmpty) return 'Enter your password';
                          if (_signUp && v.length < 8) {
                            return 'Password must be at least 8 characters';
                          }
                          return null;
                        },
                        onFieldSubmitted: (_) {
                          if (!_loading) _submitEmailAuth(auth);
                        },
                      ),
                      if (!_signUp)
                        Align(
                          alignment: Alignment.centerRight,
                          child: TextButton(
                            onPressed: _loading ? null : _resetPassword,
                            child: const Text('Forgot password?'),
                          ),
                        ),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: _loading ? null : () => _submitEmailAuth(auth),
                        child: Text(_signUp ? 'Create account' : 'Continue with Email'),
                      ),
                      TextButton(
                        onPressed: _loading
                            ? null
                            : () => setState(() => _signUp = !_signUp),
                        child: Text(
                          _signUp
                              ? 'Already have an account? Sign in'
                              : 'Need an account? Create one',
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (_loading)
              const ColoredBox(
                color: Color(0x88000000),
                child: Center(child: CircularProgressIndicator()),
              ),
          ],
        ),
      ),
    );
  }

  void _submitEmailAuth(AuthRepository auth) {
    if (!_formKey.currentState!.validate()) return;
    _run(() async {
      final email = _email.text.trim();
      final password = _password.text;
      if (_signUp) {
        await auth.signUpWithEmail(
          email: email,
          password: password,
          displayName: _displayName.text.trim(),
        );
      } else {
        await auth.signInWithEmail(email: email, password: password);
      }
    });
  }
}
