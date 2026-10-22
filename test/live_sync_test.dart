import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:quiet_vault/data/backend.dart';
import 'package:quiet_vault/data/storage.dart';
import 'package:quiet_vault/data/vault_repository.dart';

void main() {
  final credentialPath = Platform.environment['QUIET_VAULT_TEST_CREDENTIALS'];
  test(
    'live dummy account syncs with Chrome WebCrypto',
    () async {
      final credentials =
          jsonDecode(await File(credentialPath!).readAsString()) as Map;
      final client = SupabaseClient(
        'https://axncazensmjdqpczvzwf.supabase.co',
        'sb_publishable_7hGIGHFa1mcWPMI8mEZKGw_-wgkkSYT',
        authOptions: const AuthClientOptions(autoRefreshToken: false),
      );
      final response = await client.auth.signInWithPassword(
        email: credentials['email'] as String,
        password: credentials['accountPassword'] as String,
      );
      expect(response.user!.id, 'b1654caa-872c-4d37-b2d8-d1051509c5f4');
      final repo = VaultRepository(
        SupabaseVaultBackend(client),
        MemoryStorage(),
        response.user!.id,
      );
      await repo.initialize();
      const name = 'Mobile interop · synthetic test';
      if (Platform.environment['QUIET_VAULT_TEST_PHASE'] == 'verify') {
        await repo.sync();
        final item = repo.entries.singleWhere(
          (x) => x['name'] == name && x['deleted'] == false,
        );
        expect(item['value'], 'dummy-from-chrome-back');
        await repo.removeItem(item['id'] as String);
        await repo.sync();
      } else {
        final old = repo.entries
            .where((x) => x['name'] == name && x['deleted'] == false)
            .firstOrNull;
        await repo.saveItem(
          id: old?['id'] as String?,
          name: name,
          value: '  dummy-from-mobile  ',
          description: 'https://example.invalid/mobile-test',
        );
        await repo.sync();
      }
      repo.lock();
      await client.auth.signOut(scope: SignOutScope.local);
      await client.dispose();
    },
    skip: credentialPath == null
        ? 'Optional live test uses a disposable dummy account; no credentials are in this repo.'
        : false,
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
