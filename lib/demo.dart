import 'dart:async';
import 'dart:convert';
import 'auth.dart';
import 'data/backend.dart';
import 'data/vault_crypto.dart';

/// Explicit demo mode: fake values only, no remote requests or real account.
class DemoAuth implements VaultAuth {
  DemoAuth({this.signedIn = true});
  bool signedIn;
  final _changes = StreamController<Account?>.broadcast();
  static const account = Account(
    '11111111-1111-4111-8111-111111111111',
    'Demo · no sync',
  );
  @override
  Account? get current => signedIn ? account : null;
  @override
  Stream<Account?> get changes => _changes.stream;
  @override
  Future<void> signIn() async {
    signedIn = true;
    _changes.add(current);
  }

  @override
  Future<void> signOut() async {
    signedIn = false;
    _changes.add(null);
  }
}

class DemoBackend implements VaultBackend {
  DemoBackend(Json fixture)
    : row = Map<String, dynamic>.from(fixture['row'] as Map),
      secret = fixture['secret'] as String;
  Json? row;
  final String secret;
  bool online = true;
  bool staleOnce = false;
  void _check() {
    if (!online) throw TimeoutException('Offline');
  }

  Json _copy(Json value) =>
      Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);
  @override
  Future<Json?> fetch(String owner) async {
    _check();
    return row == null ? null : _copy(row!);
  }

  @override
  Future<Json> insert(Json next) async {
    _check();
    if (row != null) throw StateError('Already exists');
    row = _copy(next);
    return _copy(row!);
  }

  @override
  Future<String> managedKey({required bool create}) async {
    _check();
    return secret;
  }

  @override
  Future<Json?> save(int revision, Json encrypted) async {
    _check();
    if (staleOnce) {
      staleOnce = false;
      row!['revision'] = (row!['revision'] as int) + 1;
      return null;
    }
    if (row!['revision'] != revision) return null;
    row = {...row!, ...encrypted, 'revision': revision + 1};
    return _copy(row!);
  }
}
