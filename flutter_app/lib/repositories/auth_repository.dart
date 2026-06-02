import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../constants/google_sign_in_config.dart';

class AuthRepository {
  AuthRepository(this._auth);

  final FirebaseAuth _auth;
  Future<void>? _googleInit;

  /// Wait for Firebase Auth to restore any persisted session (required on web).
  static Future<void> ensureInitialized(FirebaseAuth auth) async {
    if (kIsWeb) {
      await auth.setPersistence(Persistence.LOCAL);
    }
    await auth.authStateChanges().first;
    if (kIsWeb && auth.currentUser == null) {
      // On web, IndexedDB restore can briefly lag behind the first stream event
      // (especially after hot restart). Poll briefly before treating as signed out.
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        if (auth.currentUser != null) break;
      }
    }
  }

  Stream<User?> authStateChanges() => _auth.authStateChanges();

  User? get currentUser => _auth.currentUser;

  Future<void> _ensureGoogleInitialized() {
    return _googleInit ??= GoogleSignIn.instance.initialize(
      clientId: kIsWeb ? kGoogleWebClientId : null,
      serverClientId: kIsWeb ? null : kGoogleWebClientId,
    );
  }

  Future<void> signInAnonymously() async {
    if (_auth.currentUser != null) return;
    await _auth.signInAnonymously();
  }

  Future<void> signInWithEmail({
    required String email,
    required String password,
  }) async {
    await _auth.signInWithEmailAndPassword(email: email, password: password);
  }

  Future<void> signUpWithEmail({
    required String email,
    required String password,
    String? displayName,
  }) async {
    final cred = await _auth.createUserWithEmailAndPassword(
      email: email,
      password: password,
    );
    if (displayName != null && displayName.isNotEmpty) {
      await cred.user?.updateDisplayName(displayName);
    }
  }

  Future<void> signInWithGoogle() async {
    if (kIsWeb) {
      final provider = GoogleAuthProvider();
      await _auth.signInWithPopup(provider);
      return;
    }

    await _ensureGoogleInitialized();
    try {
      final googleUser = await GoogleSignIn.instance.authenticate(
        scopeHint: const ['email', 'profile'],
      );
      final googleAuth = googleUser.authentication;
      final credential = GoogleAuthProvider.credential(
        idToken: googleAuth.idToken,
      );
      await _auth.signInWithCredential(credential);
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) {
        throw FirebaseAuthException(code: 'aborted-by-user');
      }
      rethrow;
    }
  }

  Future<void> sendPasswordResetEmail(String email) async {
    await _auth.sendPasswordResetEmail(email: email);
  }

  Future<void> signOut() async {
    await GoogleSignIn.instance.signOut().catchError((_) => null);
    await _auth.signOut();
  }
}
