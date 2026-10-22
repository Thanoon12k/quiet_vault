import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:quiet_vault/data/vault_repository.dart';
import 'package:quiet_vault/data/storage.dart';
import 'package:quiet_vault/data/vault_crypto.dart';
import 'package:quiet_vault/data/merge.dart';
import 'package:quiet_vault/demo.dart';

Json fixture() => Map<String, dynamic>.from(
  jsonDecode(File('test/fixtures/chrome_vault.json').readAsStringSync()) as Map,
);
const owner = '11111111-1111-4111-8111-111111111111';

class FailingStorage extends MemoryStorage {
  bool fail = false;
  @override
  Future<void> write(String key, String value) async {
    if (fail) throw StateError('Storage full');
    await super.write(key, value);
  }
}

void main() {
  test(
    'offline edit/restart preserves baseline, then syncs through stale revision',
    () async {
      final backend = DemoBackend(fixture());
      final storage = MemoryStorage();
      final first = VaultRepository(backend, storage, owner);
      await first.initialize();
      backend.online = false;
      await first.saveItem(
        name: 'Offline item',
        value: 'dummy-private-original',
        description: 'private note',
      );
      final id = first.entries.last['id'] as String;
      await first.saveItem(
        id: id,
        name: 'Offline item',
        value: 'dummy-private-edited',
        description: 'private note',
      );
      expect((first.pending[id] as Map)['baseVersion'], isNull);
      final cache = await storage.read(first.cacheKey);
      for (final text in [
        'Offline item',
        'dummy-private-edited',
        'private note',
      ]) {
        expect(cache, isNot(contains(text)));
      }
      first.lock();
      expect(first.entries, isEmpty);
      final reopened = VaultRepository(backend, storage, owner);
      await reopened.initialize();
      expect(reopened.offline, isTrue);
      expect(reopened.entries.last['value'], 'dummy-private-edited');
      backend.online = true;
      backend.staleOnce = true;
      await reopened.sync();
      expect(reopened.pending, isEmpty);
      final key = await VaultCrypto().unlock(
        owner,
        backend.secret,
        backend.row!,
      );
      expect(
        (await VaultCrypto().open(key, owner, backend.row!))['entries'],
        reopened.entries,
      );
      await reopened.forgetKey();
      reopened.lock();
      backend.online = false;
      await expectLater(
        VaultRepository(backend, storage, owner).initialize(),
        throwsA(anything),
      );
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );

  test(
    'independent devices keep conflicting edits and reject malformed descriptions',
    () async {
      final backend = DemoBackend(fixture());
      final a = VaultRepository(backend, MemoryStorage(), owner);
      await a.initialize();
      final b = VaultRepository(backend, MemoryStorage(), owner);
      await b.initialize();
      final item = a.entries.first;
      final id = item['id'] as String;
      await a.saveItem(id: id, name: 'Same item', value: 'from-phone-a');
      await a.sync();
      await b.saveItem(id: id, name: 'Same item', value: 'from-chrome-b');
      expect(await b.sync(), 1);
      expect(
        b.entries
            .where((x) => x['name'].toString().contains('conflict copy'))
            .length,
        1,
      );
      await b.sync();
      expect(b.entries.length, 4);
      expect(
        () => validateEntries([
          {...item, 'description': 12},
        ]),
        throwsFormatException,
      );
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );

  test(
    'failed local write rolls back and locked vault refuses changes',
    () async {
      final storage = FailingStorage();
      final repo = VaultRepository(DemoBackend(fixture()), storage, owner);
      await repo.initialize();
      final before = jsonEncode(repo.entries);
      storage.fail = true;
      await expectLater(
        repo.saveItem(name: 'Should roll back', value: 'dummy'),
        throwsStateError,
      );
      expect(jsonEncode(repo.entries), before);
      expect(repo.pending, isEmpty);
      repo.lock();
      await expectLater(
        repo.saveItem(name: 'Blocked', value: 'dummy'),
        throwsStateError,
      );
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test('conflicting deletion preserves edit and copy retry is idempotent', () {
    final entry = Map<String, dynamic>.from(
      (fixture()['entries'] as List).first as Map,
    );
    final id = entry['id'] as String;
    final remote = {...entry, 'version': 'remote-edit', 'value': 'kept'};
    final local = {
      ...entry,
      'version': 'local-delete',
      'deleted': true,
      'value': '',
    };
    final merged = mergeEntries([remote], [local], {
      id: {'baseVersion': entry['version']},
    });
    expect(merged.entries.single['value'], 'kept');
    expect(merged.conflicts, 1);
    final localEdit = {...entry, 'version': 'local-edit', 'value': 'other'};
    final copy = mergeEntries([remote], [localEdit], {
      id: {'baseVersion': entry['version']},
    });
    expect(
      mergeEntries(
        copy.entries,
        [localEdit],
        {
          id: {'baseVersion': entry['version']},
        },
      ).entries.length,
      2,
    );
  });
}
