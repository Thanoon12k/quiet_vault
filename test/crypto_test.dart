import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:quiet_vault/data/vault_crypto.dart';

void main() {
  final fixture = Map<String, dynamic>.from(
    jsonDecode(File('test/fixtures/chrome_vault.json').readAsStringSync())
        as Map,
  );
  final crypto = VaultCrypto();
  final owner = fixture['owner'] as String;
  final secret = fixture['secret'] as String;
  final row = Map<String, dynamic>.from(fixture['row'] as Map);
  test(
    'opens actual Chrome WebCrypto payload and encrypted offline cache',
    () async {
      final key = await crypto.unlock(owner, secret, row);
      expect(
        (await crypto.open(key, owner, row))['entries'],
        fixture['entries'],
      );
      expect(
        (await crypto.open(
          key,
          owner,
          Map<String, dynamic>.from(fixture['cache'] as Map),
          purpose: 'cache',
        ))['entries'],
        fixture['entries'],
      );
      await expectLater(
        crypto.open(key, 'another-owner', row),
        throwsA(anything),
      );
      await expectLater(
        crypto.open(key, owner, row, purpose: 'cache'),
        throwsA(anything),
      );
      final bytes = base64Decode(row['ciphertext'] as String);
      bytes[0] ^= 1;
      await expectLater(
        crypto.open(key, owner, {...row, 'ciphertext': base64Encode(bytes)}),
        throwsA(anything),
      );
      await expectLater(
        crypto.unlock(owner, secret, {...row, 'iterations': 1}),
        throwsA(anything),
      );
      final entries = [
        ...(fixture['entries'] as List),
        {
          'id': 'mobile-interop',
          'version': 'mobile-interop-v1',
          'name': 'مفتاح تجريبي',
          'value': '  dummy-mobile-secret  ',
          'kind': 'Secret',
          'description': 'https://example.invalid/keys',
          'deleted': false,
          'updatedAt': '2026-10-22T08:00:00.000Z',
        },
      ];
      final encrypted = await crypto.seal(key, owner, {'entries': entries});
      final second = await crypto.seal(key, owner, {'entries': entries});
      expect(encrypted['nonce'], isNot(second['nonce']));
      final file = File('build/mobile-to-chrome.json');
      await file.parent.create(recursive: true);
      await file.writeAsString(
        jsonEncode({
          'owner': owner,
          'secret': secret,
          'row': row,
          'encrypted': encrypted,
          'entries': entries,
        }),
      );
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
