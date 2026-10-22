import 'dart:async';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'data/storage.dart';

const mobileCallback = 'com.thanoon.quietvault://login-callback';

class Account {
  const Account(this.id, this.email);
  final String id;
  final String email;
}

abstract interface class VaultAuth {
  Account? get current;
  Stream<Account?> get changes;
  Future<void> signIn();
  Future<void> signOut();
}

class GoogleVaultAuth implements VaultAuth {
  GoogleVaultAuth(this.client);
  final SupabaseClient client;
  Account? _account(User? user) =>
      user == null ? null : Account(user.id, user.email ?? 'Google account');
  @override
  Account? get current => _account(client.auth.currentUser);
  @override
  Stream<Account?> get changes => client.auth.onAuthStateChange.map(
    (state) => _account(state.session?.user),
  );
  @override
  Future<void> signIn() async {
    final launched = await client.auth.signInWithOAuth(
      OAuthProvider.google,
      redirectTo: mobileCallback,
      authScreenLaunchMode: LaunchMode.externalApplication,
      queryParams: {'prompt': 'select_account'},
    );
    if (!launched) {
      throw StateError('Could not open Google sign-in. Try again.');
    }
  }

  @override
  Future<void> signOut() => client.auth.signOut(scope: SignOutScope.local);
}

class SecurePkceStorage extends GotrueAsyncStorage {
  SecurePkceStorage(this.storage);
  final VaultStorage storage;
  @override
  Future<String?> getItem({required String key}) =>
      storage.read('quiet-vault.pkce.$key');
  @override
  Future<void> setItem({required String key, required String value}) =>
      storage.write('quiet-vault.pkce.$key', value);
  @override
  Future<void> removeItem({required String key}) =>
      storage.remove('quiet-vault.pkce.$key');
}
