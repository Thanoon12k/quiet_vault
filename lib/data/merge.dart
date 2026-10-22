import 'vault_crypto.dart';

List<Json> validateEntries(dynamic input) {
  if (input is! List || input.length > 10000) {
    throw const FormatException('Invalid vault contents.');
  }
  final ids = <String>{};
  return input.map((value) {
    if (value is! Map) throw const FormatException('Invalid vault item.');
    final item = Map<String, dynamic>.from(value);
    for (final key in ['id', 'version', 'name', 'value', 'kind', 'updatedAt']) {
      if (item[key] is! String) {
        throw const FormatException('Invalid vault item.');
      }
    }
    if (item['deleted'] is! bool ||
        !ids.add(item['id'] as String) ||
        (item['description'] != null &&
            (item['description'] is! String ||
                (item['description'] as String).length > 2000))) {
      throw const FormatException('Invalid vault item.');
    }
    return item;
  }).toList();
}

/// Exactly the extension's baseline/version merge, including idempotent copies.
({List<Json> entries, int conflicts}) mergeEntries(
  List<Json> remote,
  List<Json> local,
  Json pending,
) {
  final entries = {
    for (final item in remote)
      item['id'] as String: Map<String, dynamic>.from(item),
  };
  final oursById = {for (final item in local) item['id'] as String: item};
  var conflicts = 0;
  for (final change in pending.entries) {
    final ours = oursById[change.key];
    if (ours == null) throw const FormatException('Incomplete local vault.');
    final theirs = entries[change.key];
    if (theirs?['version'] == ours['version'] ||
        entries[ours['version']]?['version'] == ours['version']) {
      continue;
    }
    if (theirs?['version'] == (change.value as Map)['baseVersion']) {
      entries[change.key] = Map<String, dynamic>.from(ours);
    } else {
      conflicts++;
      if (ours['deleted'] != true) {
        final copyId = ours['version'] as String;
        entries[copyId] = {
          ...ours,
          'id': copyId,
          'name': '${ours['name']} (conflict copy)',
        };
      }
    }
  }
  return (entries: entries.values.toList(), conflicts: conflicts);
}
