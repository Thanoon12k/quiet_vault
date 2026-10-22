import 'dart:async';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'vault_crypto.dart';

abstract interface class VaultBackend {
  Future<Json?> fetch(String owner);
  Future<Json> insert(Json row);
  Future<String> managedKey({required bool create});
  Future<Json?> save(int revision, Json encrypted);
}

class SupabaseVaultBackend implements VaultBackend {
  SupabaseVaultBackend(this.client);
  final SupabaseClient client;
  @override
  Future<Json?> fetch(String owner) => client
      .from('quiet_vaults')
      .select()
      .eq('user_id', owner)
      .maybeSingle()
      .timeout(const Duration(seconds: 12));
  @override
  Future<Json> insert(Json row) => client
      .from('quiet_vaults')
      .insert(row)
      .select()
      .single()
      .timeout(const Duration(seconds: 12));
  @override
  Future<String> managedKey({required bool create}) async {
    final value = await client
        .rpc('quiet_vault_managed_key', params: {'create_if_missing': create})
        .timeout(const Duration(seconds: 12));
    if (value is! String || value.length != 44) {
      throw StateError('Your vault key is unavailable. Sign in again.');
    }
    return value;
  }

  @override
  Future<Json?> save(int revision, Json encrypted) async {
    final rows = await client
        .rpc(
          'quiet_vault_save',
          params: {
            'expected_revision': revision,
            'new_ciphertext': encrypted['ciphertext'],
            'new_nonce': encrypted['nonce'],
          },
        )
        .timeout(const Duration(seconds: 12));
    return (rows as List).isEmpty
        ? null
        : Map<String, dynamic>.from(rows.first as Map);
  }
}
