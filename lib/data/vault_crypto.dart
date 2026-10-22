import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';

typedef Json = Map<String, dynamic>;

/// Version 1 wire format shared with quiet-vault/src/crypto.js.
class VaultCrypto {
  static const iterations = 600000;
  static const maxBytes = 900000;
  final _aes = AesGcm.with256bits();
  final _random = Random.secure();
  List<int> _randomBytes(int count) =>
      List.generate(count, (_) => _random.nextInt(256));
  List<int> _aad(String owner, String purpose) =>
      utf8.encode('quiet-vault:v1:$owner:$purpose');

  Future<SecretKey> _wrappingKey(String password, Json row) {
    if (row['iterations'] != iterations) {
      throw const FormatException('Unsupported vault version.');
    }
    return Pbkdf2(
      macAlgorithm: Hmac.sha256(),
      iterations: iterations,
      bits: 256,
    ).deriveKey(
      secretKey: SecretKey(utf8.encode(password)),
      nonce: base64Decode(row['salt'] as String),
    );
  }

  Future<Json> seal(
    SecretKey key,
    String owner,
    Json value, {
    String purpose = 'payload',
  }) async {
    final bytes = utf8.encode(jsonEncode(value));
    if (bytes.length > maxBytes) {
      throw StateError('Vault is full. Shorten a value before saving.');
    }
    final box = await _aes.encrypt(
      bytes,
      secretKey: key,
      nonce: _randomBytes(12),
      aad: _aad(owner, purpose),
    );
    return {
      'ciphertext': base64Encode([...box.cipherText, ...box.mac.bytes]),
      'nonce': base64Encode(box.nonce),
    };
  }

  Future<Json> open(
    SecretKey key,
    String owner,
    Json envelope, {
    String purpose = 'payload',
  }) async {
    final bytes = base64Decode(envelope['ciphertext'] as String);
    final nonce = base64Decode(envelope['nonce'] as String);
    if (bytes.length < 16 || nonce.length != 12) {
      throw const FormatException('Invalid encrypted vault.');
    }
    final box = SecretBox(
      bytes.sublist(0, bytes.length - 16),
      nonce: nonce,
      mac: Mac(bytes.sublist(bytes.length - 16)),
    );
    final plain = await _aes.decrypt(
      box,
      secretKey: key,
      aad: _aad(owner, purpose),
    );
    return Map<String, dynamic>.from(jsonDecode(utf8.decode(plain)) as Map);
  }

  Future<SecretKey> unlock(String owner, String secret, Json row) async {
    if (row['format'] != 1 || row['user_id'] != owner) {
      throw const FormatException('Wrong vault account or format.');
    }
    final wrapped = base64Decode(row['wrapped_key'] as String);
    final nonce = base64Decode(row['wrap_nonce'] as String);
    if (wrapped.length != 48 ||
        nonce.length != 12 ||
        base64Decode(row['salt'] as String).length != 16) {
      throw const FormatException('Invalid wrapped vault key.');
    }
    final raw = Uint8List.fromList(
      await _aes.decrypt(
        SecretBox(
          wrapped.sublist(0, 32),
          nonce: nonce,
          mac: Mac(wrapped.sublist(32)),
        ),
        secretKey: await _wrappingKey(secret, row),
        aad: _aad(owner, 'key'),
      ),
    );
    try {
      return SecretKey(List<int>.from(raw));
    } finally {
      raw.fillRange(0, raw.length, 0);
    }
  }

  Future<({SecretKey key, Json row})> create(
    String owner,
    String secret,
  ) async {
    final row = <String, dynamic>{
      'user_id': owner,
      'format': 1,
      'iterations': iterations,
      'salt': base64Encode(_randomBytes(16)),
      'revision': 1,
      'unlock_mode': 'managed',
    };
    final raw = Uint8List.fromList(_randomBytes(32));
    try {
      final key = SecretKey(List<int>.from(raw));
      final box = await _aes.encrypt(
        raw,
        secretKey: await _wrappingKey(secret, row),
        nonce: _randomBytes(12),
        aad: _aad(owner, 'key'),
      );
      row.addAll({
        'wrapped_key': base64Encode([...box.cipherText, ...box.mac.bytes]),
        'wrap_nonce': base64Encode(box.nonce),
      });
      row.addAll(await seal(key, owner, {'entries': <Json>[]}));
      return (key: key, row: row);
    } finally {
      raw.fillRange(0, raw.length, 0);
    }
  }
}
