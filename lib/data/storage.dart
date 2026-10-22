import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

abstract interface class VaultStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> remove(String key);
}

class DeviceStorage implements VaultStorage {
  const DeviceStorage();
  static const _storage = FlutterSecureStorage();
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
  @override
  Future<void> remove(String key) => _storage.delete(key: key);
}

/// Store the Supabase account session in Android Keystore-backed storage.
class SecureAuthStorage extends LocalStorage {
  const SecureAuthStorage(this.storage);
  final VaultStorage storage;
  static const _key = 'quiet-vault.mobile-auth.v1';
  @override
  Future<void> initialize() async {}
  @override
  Future<String?> accessToken() => storage.read(_key);
  @override
  Future<bool> hasAccessToken() async => await storage.read(_key) != null;
  @override
  Future<void> persistSession(String value) => storage.write(_key, value);
  @override
  Future<void> removePersistedSession() => storage.remove(_key);
}

class MemoryStorage implements VaultStorage {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> remove(String key) async {
    values.remove(key);
  }
}
