import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'app.dart';
import 'auth.dart';
import 'data/backend.dart';
import 'data/storage.dart';
import 'demo.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (const bool.fromEnvironment('QUIET_VAULT_DEMO')) {
    final fixture = Map<String, dynamic>.from(
      jsonDecode(await rootBundle.loadString('assets/demo.json')) as Map,
    );
    runApp(
      QuietVaultApp(
        auth: DemoAuth(),
        backend: DemoBackend(fixture),
        storage: MemoryStorage(),
        demo: true,
      ),
    );
    return;
  }
  const storage = DeviceStorage();
  await Supabase.initialize(
    url: 'https://axncazensmjdqpczvzwf.supabase.co',
    publishableKey: 'sb_publishable_7hGIGHFa1mcWPMI8mEZKGw_-wgkkSYT',
    authOptions: FlutterAuthClientOptions(
      authFlowType: AuthFlowType.pkce,
      localStorage: const SecureAuthStorage(storage),
      pkceAsyncStorage: SecurePkceStorage(storage),
      detectSessionInUriPredicate: (uri) =>
          uri.scheme == 'com.thanoon.quietvault' &&
          uri.host == 'login-callback' &&
          uri.path.isEmpty &&
          uri.fragment.isEmpty &&
          uri.queryParametersAll['code']?.length == 1,
    ),
    debug: false,
  );
  final client = Supabase.instance.client;
  runApp(
    QuietVaultApp(
      auth: GoogleVaultAuth(client),
      backend: SupabaseVaultBackend(client),
      storage: storage,
    ),
  );
}
