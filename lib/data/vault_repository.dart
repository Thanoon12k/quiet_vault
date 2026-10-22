import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:cryptography/cryptography.dart';
import 'package:uuid/uuid.dart';
import 'backend.dart';
import 'merge.dart';
import 'storage.dart';
import 'vault_crypto.dart';

class VaultRepository {
  VaultRepository(this.backend, this.storage, this.owner);
  final VaultBackend backend;
  final VaultStorage storage;
  final String owner;
  final crypto = VaultCrypto();
  final _uuid = const Uuid();
  SecretKey? _key;
  Json? row;
  List<Json> entries = [];
  Json pending = {};
  bool closed = false;
  bool offline = false;
  Future<void> _tail = Future.value();
  String get cacheKey => 'quiet-vault.mobile-cache.v1.$owner';
  String get secretKey => 'quiet-vault.mobile-key.v1.$owner';
  bool get isOpen => _key != null && !closed;

  Future<T> _serial<T>(Future<T> Function() task) {
    final result = _tail.then((_) {
      if (closed) throw StateError('Vault is locked.');
      return task();
    });
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  static bool networkFailure(Object error) =>
      error is SocketException ||
      error is TimeoutException ||
      RegExp(
        r'socket|network|failed host|connection|clientexception',
        caseSensitive: false,
      ).hasMatch(error.toString());

  Future<void> initialize() async {
    final saved = await storage.read(cacheKey);
    final cached = saved == null
        ? null
        : Map<String, dynamic>.from(jsonDecode(saved) as Map);
    Json? remote;
    String? secret;
    try {
      remote = await backend.fetch(owner);
      if (remote != null && remote['unlock_mode'] != 'managed') {
        throw StateError(
          'Open the Chrome extension once to finish switching this vault to Google-only access.',
        );
      }
      secret = await backend.managedKey(create: remote == null);
      await storage.write(secretKey, secret);
    } catch (error) {
      if (!networkFailure(error) || cached == null) rethrow;
      secret = await storage.read(secretKey);
      if (secret == null) rethrow;
      remote = Map<String, dynamic>.from(cached['row'] as Map);
      offline = true;
    }
    if (closed) throw StateError('Vault is locked.');
    if (remote == null) {
      if (cached != null) {
        throw StateError(
          'The cloud vault was reset. Your old offline edits are preserved on this device.',
        );
      }
      final created = await crypto.create(owner, secret);
      try {
        row = await backend.insert(created.row);
        _key = created.key;
      } catch (_) {
        // The extension/another phone may have created the vault simultaneously.
        final existing = await backend.fetch(owner);
        if (existing == null || existing['unlock_mode'] != 'managed') rethrow;
        row = existing;
        _key = await crypto.unlock(owner, secret, existing);
        entries = validateEntries(
          (await crypto.open(_key!, owner, existing))['entries'],
        );
      }
    } else {
      final key = await crypto.unlock(owner, secret, remote);
      final contents = cached == null
          ? await crypto.open(key, owner, remote)
          : await crypto.open(
              key,
              owner,
              Map<String, dynamic>.from(cached['encrypted'] as Map),
              purpose: 'cache',
            );
      if (closed) throw StateError('Vault is locked.');
      _key = key;
      row = remote;
      entries = validateEntries(contents['entries']);
      if (cached != null) {
        pending = Map<String, dynamic>.from(contents['pending'] as Map);
      }
    }
    if (closed) {
      lock();
      throw StateError('Vault is locked.');
    }
    await _persist();
  }

  Future<void> _persist() async {
    if (!isOpen) throw StateError('Vault is locked.');
    final encrypted = await crypto.seal(_key!, owner, {
      'entries': entries,
      'pending': pending,
    }, purpose: 'cache');
    if (closed) throw StateError('Vault is locked.');
    await storage.write(
      cacheKey,
      jsonEncode({'row': row, 'encrypted': encrypted}),
    );
  }

  Future<void> saveItem({
    String? id,
    required String name,
    required String value,
    String description = '',
  }) => _serial(() async {
    if (name.trim().isEmpty ||
        name.trim().length > 160 ||
        value.isEmpty ||
        value.length > 32000 ||
        description.length > 2000) {
      throw StateError(
        'Enter a name and secret. Values can contain up to 32,000 characters.',
      );
    }
    final old = id == null
        ? null
        : entries
              .where((x) => x['id'] == id && x['deleted'] == false)
              .firstOrNull;
    if (id != null && old == null) {
      throw StateError('This secret no longer exists.');
    }
    final itemId = id ?? _uuid.v4();
    final record = <String, dynamic>{
      'id': itemId,
      'name': name.trim(),
      'value': value,
      'description': description,
      'kind': old?['kind'] ?? 'Secret',
      'deleted': false,
      'version': _uuid.v4(),
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    await _mutate(
      [...entries.where((x) => x['id'] != itemId), record],
      {
        ...pending,
        itemId: {
          'baseVersion': pending.containsKey(itemId)
              ? (pending[itemId] as Map)['baseVersion']
              : old?['version'],
        },
      },
    );
  });

  Future<void> removeItem(String id) => _serial(() async {
    final old = entries
        .where((x) => x['id'] == id && x['deleted'] == false)
        .firstOrNull;
    if (old == null) return;
    await _mutate(
      entries
          .map(
            (x) => x['id'] != id
                ? x
                : {
                    ...x,
                    'name': '',
                    'value': '',
                    'description': '',
                    'deleted': true,
                    'version': _uuid.v4(),
                    'updatedAt': DateTime.now().toUtc().toIso8601String(),
                  },
          )
          .toList(),
      {
        ...pending,
        id: {
          'baseVersion': pending.containsKey(id)
              ? (pending[id] as Map)['baseVersion']
              : old['version'],
        },
      },
    );
  });

  Future<void> _mutate(List<Json> next, Json changes) async {
    final previous = entries;
    final previousPending = pending;
    entries = next;
    pending = changes;
    try {
      await _persist();
    } catch (_) {
      if (!closed) {
        entries = previous;
        pending = previousPending;
      }
      rethrow;
    }
  }

  Future<int> sync() => _serial(() async {
    try {
      for (var attempt = 0; attempt < 3; attempt++) {
        final remote = await backend.fetch(owner);
        if (remote == null) {
          throw StateError(
            'Cloud vault unavailable. Your edits remain saved on this phone.',
          );
        }
        final contents = await crypto.open(_key!, owner, remote);
        final remoteEntries = validateEntries(contents['entries']);
        final merged = mergeEntries(remoteEntries, entries, pending);
        final Json? updated;
        if (pending.isEmpty) {
          updated = remote;
        } else {
          updated = await backend.save(
            remote['revision'] as int,
            await crypto.seal(_key!, owner, {'entries': merged.entries}),
          );
        }
        if (updated == null) continue;
        if (closed) throw StateError('Vault is locked.');
        final oldRow = row;
        row = updated;
        try {
          await _mutate(merged.entries, {});
        } catch (_) {
          if (!closed) row = oldRow;
          rethrow;
        }
        offline = false;
        return merged.conflicts;
      }
      throw StateError(
        'Another device is updating the vault. Try syncing again shortly.',
      );
    } catch (error) {
      if (networkFailure(error)) offline = true;
      rethrow;
    }
  });

  void lock() {
    closed = true;
    _key = null;
    entries = [];
    pending = {};
    row = null;
  }

  Future<void> forgetKey() => storage.remove(secretKey);
}
