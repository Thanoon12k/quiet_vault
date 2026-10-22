import 'dart:async';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'auth.dart';
import 'data/backend.dart';
import 'data/storage.dart';
import 'data/vault_crypto.dart';
import 'data/vault_repository.dart';

const ink = Color(0xff263c35);
const green = Color(0xff355a45);
const paper = Color(0xfff8f9f5);

class QuietVaultApp extends StatelessWidget {
  const QuietVaultApp({
    super.key,
    required this.auth,
    required this.backend,
    required this.storage,
    this.demo = false,
  });
  final VaultAuth auth;
  final VaultBackend backend;
  final VaultStorage storage;
  final bool demo;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Quiet Vault',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: paper,
      colorScheme: ColorScheme.fromSeed(
        seedColor: green,
        brightness: Brightness.light,
        surface: paper,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: paper,
        surfaceTintColor: Colors.transparent,
      ),
      textTheme: const TextTheme(
        headlineMedium: TextStyle(
          fontSize: 27,
          fontWeight: FontWeight.w500,
          letterSpacing: -0.8,
          color: ink,
        ),
        titleLarge: TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w500,
          color: ink,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xffdfe5d9)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xffdfe5d9)),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: green,
          foregroundColor: Colors.white,
          minimumSize: const Size(0, 46),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
    ),
    home: VaultScreen(
      auth: auth,
      backend: backend,
      storage: storage,
      demo: demo,
    ),
  );
}

class VaultScreen extends StatefulWidget {
  const VaultScreen({
    super.key,
    required this.auth,
    required this.backend,
    required this.storage,
    required this.demo,
  });
  final VaultAuth auth;
  final VaultBackend backend;
  final VaultStorage storage;
  final bool demo;
  @override
  State<VaultScreen> createState() => _VaultScreenState();
}

class _VaultScreenState extends State<VaultScreen> with WidgetsBindingObserver {
  Account? _account;
  VaultRepository? _vault;
  StreamSubscription<Account?>? _authEvents;
  Timer? _idle, _periodic, _revealTimer;
  int _generation = 0;
  bool _loading = false,
      _syncing = false,
      _editing = false,
      _show = false,
      _saving = false;
  bool _needsName = false, _showOptions = false;
  String? _editId;
  String _draftName = '', _error = '';
  final _search = TextEditingController();
  final _name = TextEditingController();
  final _value = TextEditingController();
  final _description = TextEditingController();
  final _form = GlobalKey<FormState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _account = widget.auth.current;
    _authEvents = widget.auth.changes.listen(
      (account) {
        if (!mounted) return;
        if (account?.id == _account?.id &&
            (_loading || _vault?.isOpen == true)) {
          return;
        }
        _cover();
        setState(() {
          _account = account;
          _error = '';
        });
        if (account != null) unawaited(_open());
      },
      onError: (Object _) {
        if (mounted) {
          setState(() {
            _loading = false;
            _error = 'Google sign-in could not finish. Please try again.';
          });
        }
      },
    );
    if (_account != null) unawaited(_open());
    _periodic = Timer.periodic(const Duration(seconds: 45), (_) {
      if (_vault?.isOpen == true) unawaited(_sync());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _generation++;
    _authEvents?.cancel();
    _idle?.cancel();
    _periodic?.cancel();
    _revealTimer?.cancel();
    _vault?.lock();
    for (final c in [_search, _name, _value, _description]) {
      c.clear();
      c.dispose();
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      if (_vault != null) {
        _cover();
        if (mounted) setState(() {});
      }
    }
  }

  void _touch() {
    _idle?.cancel();
    if (_vault?.isOpen == true) {
      _idle = Timer(const Duration(minutes: 2), () {
        _cover();
        if (mounted) setState(() {});
      });
    }
  }

  void _clearEditor() {
    _editing = false;
    _show = false;
    _saving = false;
    _editId = null;
    _draftName = '';
    _revealTimer?.cancel();
    _name.clear();
    _value.clear();
    _description.clear();
  }

  void _cover() {
    _generation++;
    _vault?.lock();
    _vault = null;
    _loading = false;
    _syncing = false;
    _showOptions = false;
    _clearEditor();
    _search.clear();
    _idle?.cancel();
  }

  String _friendly(Object error) {
    if (VaultRepository.networkFailure(error)) {
      return 'Sync paused. Your changes are saved on this phone.';
    }
    if (error is StateError) return error.message;
    if (error is FormatException) {
      return 'Could not open the encrypted vault. Reconnect and try again.';
    }
    return 'Could not finish. Please try again.';
  }

  void _toast(String text) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(text), duration: const Duration(seconds: 3)),
      );
    }
  }

  Future<void> _open() async {
    final account = _account;
    if (account == null) return;
    final stamp = ++_generation;
    setState(() {
      _loading = true;
      _error = '';
    });
    final next = VaultRepository(widget.backend, widget.storage, account.id);
    _vault = next;
    try {
      await next.initialize();
      if (!mounted || stamp != _generation) {
        next.lock();
        return;
      }
      setState(() {
        _loading = false;
      });
      _touch();
      unawaited(_sync());
    } catch (error) {
      next.lock();
      if (mounted && stamp == _generation) {
        setState(() {
          _loading = false;
          _error = _friendly(error);
        });
      }
    }
  }

  Future<void> _sync({bool manual = false}) async {
    final current = _vault;
    if (current?.isOpen != true || _syncing) return;
    setState(() {
      _syncing = true;
    });
    try {
      final conflicts = await current!.sync();
      if (mounted && _vault == current) {
        setState(() {
          _error = '';
        });
        if (conflicts > 0) {
          _toast('Both edits were kept. Look for a conflict copy.');
        } else if (manual) {
          _toast('Vault is up to date.');
        }
      }
    } catch (error) {
      if (mounted && _vault == current) {
        setState(() {
          _error = _friendly(error);
        });
      }
    } finally {
      if (mounted && _vault == current) {
        setState(() {
          _syncing = false;
        });
      }
    }
  }

  Future<void> _signIn() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      await widget.auth.signIn();
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Google sign-in could not start. Please try again.';
        });
      }
    } finally {
      if (mounted && _account == null) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  Future<void> _signOut() async {
    final current = _vault;
    final owner = _account?.id;
    _cover();
    setState(() {
      _loading = true;
    });
    try {
      if (owner != null) {
        await widget.storage.remove('quiet-vault.mobile-key.v1.$owner');
      }
      await current?.forgetKey();
      await widget.auth.signOut();
      if (mounted) {
        setState(() {
          _account = null;
          _error = '';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Could not sign out. Reconnect and try again.';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  void _edit([Json? item]) {
    _touch();
    _clearEditor();
    setState(() {
      _editing = true;
      _showOptions = false;
      _editId = item?['id'] as String?;
      _draftName = item?['name'] as String? ?? _search.text.trim();
      _needsName = item != null || _draftName.isEmpty;
      _name.text = _draftName;
      _value.text = item?['value'] as String? ?? '';
      _description.text = item?['description'] as String? ?? '';
      _error = '';
    });
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final current = _vault;
    if (current?.isOpen != true) return;
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      await current!.saveItem(
        id: _editId,
        name: _needsName ? _name.text : _draftName,
        value: _value.text,
        description: _description.text,
      );
      if (mounted && _vault == current) {
        setState(() {
          _clearEditor();
          _search.clear();
        });
        _toast('Saved.');
        unawaited(_sync());
      }
    } catch (error) {
      if (mounted && _vault == current) {
        setState(() {
          _error = _friendly(error);
        });
      }
    } finally {
      if (mounted && _vault == current) {
        setState(() {
          _saving = false;
        });
      }
    }
  }

  Future<void> _delete() async {
    final current = _vault;
    final id = _editId;
    if (current == null || id == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete this secret?'),
        content: const Text('This removes it from your synced vault.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || _vault != current || !current.isOpen) return;
    try {
      await current.removeItem(id);
      if (mounted && _vault == current) {
        setState(_clearEditor);
        _toast('Deleted.');
        unawaited(_sync());
      }
    } catch (error) {
      if (mounted) _toast(_friendly(error));
    }
  }

  Widget _brand() => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Image.asset('assets/mascot.png', width: 34, height: 34),
      const SizedBox(width: 8),
      const Text(
        'quiet vault.',
        style: TextStyle(
          fontSize: 21,
          color: ink,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.7,
        ),
      ),
    ],
  );
  Widget _button(String text, VoidCallback? action) => SizedBox(
    width: double.infinity,
    child: FilledButton(onPressed: action, child: Text(text)),
  );
  Widget _errorView() => Padding(
    padding: const EdgeInsets.only(top: 14),
    child: Text(
      _error,
      style: const TextStyle(color: Color(0xffa15d48), fontSize: 13),
    ),
  );
  Widget _title(String title) => Padding(
    padding: const EdgeInsets.only(bottom: 18),
    child: Text(title, style: Theme.of(context).textTheme.headlineMedium),
  );

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) => _touch(),
    child: PopScope(
      canPop: !_editing && !_showOptions,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) {
          setState(() {
            _clearEditor();
            _showOptions = false;
          });
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: _brand(),
          automaticallyImplyLeading: false,
          actions: _vault?.isOpen == true
              ? [
                  IconButton(
                    tooltip: 'Vault options',
                    onPressed: () => setState(() {
                      _clearEditor();
                      _showOptions = !_showOptions;
                    }),
                    icon: const Icon(Icons.more_horiz),
                  ),
                ]
              : null,
        ),
        body: SafeArea(
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(22, 20, 22, 28),
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                child: _account == null
                    ? _authView()
                    : _loading
                    ? const Padding(
                        padding: EdgeInsets.all(50),
                        child: Center(child: CircularProgressIndicator()),
                      )
                    : _vault?.isOpen != true
                    ? _lockedView()
                    : _showOptions
                    ? _optionsView()
                    : _editing
                    ? _editorView()
                    : _homeView(),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  Widget _authView() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const SizedBox(height: 45),
      _title('Everything, in one place.'),
      const Text(
        'API keys, passwords, and the little things you need to keep safe.',
        style: TextStyle(height: 1.6, color: Color(0xff7b837c)),
      ),
      const SizedBox(height: 28),
      _button(
        _loading ? 'Opening Google…' : 'Continue with Google',
        _loading ? null : _signIn,
      ),
      if (_error.isNotEmpty) _errorView(),
      const SizedBox(height: 22),
      const Text(
        'One account. The same secrets on your phone and in Chrome.',
        style: TextStyle(fontSize: 12, height: 1.6, color: Color(0xff899681)),
      ),
    ],
  );

  Widget _lockedView() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _title('Ready when you are.'),
      const Text(
        'Open your vault to continue.',
        style: TextStyle(color: Color(0xff7b837c)),
      ),
      const SizedBox(height: 24),
      _button('Open vault', _open),
      if (_error.isNotEmpty) _errorView(),
      TextButton(onPressed: _signOut, child: const Text('Sign out')),
    ],
  );

  Widget _homeView() {
    final vault = _vault!;
    final query = _search.text.trim().toLowerCase();
    final items =
        vault.entries
            .where(
              (item) =>
                  item['deleted'] == false &&
                  '${item['name']} ${item['kind']}'.toLowerCase().contains(
                    query,
                  ),
            )
            .toList()
          ..sort(
            (a, b) => (a['name'] as String).toLowerCase().compareTo(
              (b['name'] as String).toLowerCase(),
            ),
          );
    final status = widget.demo
        ? 'Demo · no sync'
        : _syncing
        ? 'Syncing…'
        : vault.offline
        ? 'Offline · retry'
        : vault.pending.isNotEmpty
        ? 'Saved on phone'
        : 'Synced';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Your secrets.',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
            ),
            TextButton(
              onPressed: () => _sync(manual: true),
              child: Text(status, style: const TextStyle(fontSize: 11)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('search'),
                controller: _search,
                maxLength: 160,
                decoration: const InputDecoration(
                  hintText: 'Find or name a secret…',
                  prefixIcon: Icon(Icons.search, size: 20),
                  counterText: '',
                ),
                onChanged: (_) {
                  _touch();
                  setState(() {});
                },
                onSubmitted: (_) => _edit(),
              ),
            ),
            const SizedBox(width: 9),
            FilledButton(onPressed: () => _edit(), child: const Text('Add')),
          ],
        ),
        const SizedBox(height: 22),
        Text(
          '${items.length} ${items.length == 1 ? 'SECRET' : 'SECRETS'}',
          style: const TextStyle(
            fontSize: 10,
            letterSpacing: 1.5,
            color: Color(0xff899681),
          ),
        ),
        if (items.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 42),
            child: Center(
              child: Column(
                children: [
                  const Icon(
                    Icons.key_rounded,
                    size: 34,
                    color: Color(0xff9baa89),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    query.isEmpty
                        ? 'A little less to remember.'
                        : 'Nothing by that name.',
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    query.isEmpty
                        ? 'Add your first secret when you’re ready.'
                        : 'Press Add to save it here.',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xff899681),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ...items.map(
          (item) => Container(
            padding: const EdgeInsets.only(top: 10, bottom: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Color(0xffe8ece3))),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: InkWell(
                        onTap: () => _edit(item),
                        borderRadius: BorderRadius.circular(10),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 7),
                          child: Row(
                            children: [
                              Container(
                                width: 36,
                                height: 38,
                                decoration: BoxDecoration(
                                  color: const Color(0xffeaf0e4),
                                  borderRadius: BorderRadius.circular(11),
                                ),
                                child: const Icon(
                                  Icons.key_rounded,
                                  size: 18,
                                  color: Color(0xff80996d),
                                ),
                              ),
                              const SizedBox(width: 11),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      item['name'] as String,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                    const SizedBox(height: 4),
                                    const Text(
                                      '••••••••',
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: Color(0xff98a090),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Copy ${item['name']}',
                      onPressed: () async {
                        await Clipboard.setData(
                          ClipboardData(text: item['value'] as String),
                        );
                        _toast('Copied.');
                      },
                      icon: const Icon(
                        Icons.copy_rounded,
                        size: 19,
                        color: Color(0xff899681),
                      ),
                    ),
                  ],
                ),
                if ((item['description'] as String? ?? '').isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(left: 47, top: 2),
                    child: LinkedNote(text: item['description'] as String),
                  ),
              ],
            ),
          ),
        ),
        if (_error.isNotEmpty) _errorView(),
        const SizedBox(height: 24),
        const Center(
          child: Text(
            'A little space for your secrets.',
            style: TextStyle(fontSize: 11, color: Color(0xffa6ad9e)),
          ),
        ),
      ],
    );
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    bool secret = false,
    bool required = false,
    int max = 2000,
    String? hint,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      controller: controller,
      obscureText: secret && !_show,
      enableSuggestions: !secret,
      autocorrect: false,
      maxLength: max,
      onChanged: (_) => _touch(),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        counterText: '',
        suffixIcon: secret
            ? IconButton(
                tooltip: _show ? 'Hide secret' : 'Show secret',
                icon: Icon(
                  _show
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                  size: 20,
                ),
                onPressed: () {
                  setState(() {
                    _show = !_show;
                  });
                  _revealTimer?.cancel();
                  if (_show) {
                    _revealTimer = Timer(const Duration(seconds: 15), () {
                      if (mounted) {
                        setState(() {
                          _show = false;
                        });
                      }
                    });
                  }
                },
              )
            : null,
      ),
      validator: (text) =>
          required &&
              (text == null || (secret ? text.isEmpty : text.trim().isEmpty))
          ? 'Enter ${label.toLowerCase()}.'
          : null,
    ),
  );

  Widget _editorView() => Form(
    key: _form,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: _saving ? null : () => setState(_clearEditor),
          icon: const Icon(Icons.arrow_back, size: 16),
          label: const Text('All secrets'),
        ),
        const SizedBox(height: 12),
        _title(
          _editId != null
              ? 'The details.'
              : _draftName.isEmpty
              ? 'Add a secret'
              : _draftName,
        ),
        if (_needsName) _field('Name', _name, required: true, max: 160),
        _field(
          'Token or password',
          _value,
          secret: true,
          required: true,
          max: 32000,
          hint: 'Paste your secret',
        ),
        _field(
          'Description or link (optional)',
          _description,
          hint: 'https://… or a short note',
        ),
        if (_error.isNotEmpty) _errorView(),
        _button(
          _saving
              ? 'Saving…'
              : _editId == null
              ? 'Save secret'
              : 'Save changes',
          _saving ? null : _save,
        ),
        if (_editId != null)
          Center(
            child: TextButton(
              onPressed: _saving ? null : _delete,
              child: const Text(
                'Delete secret',
                style: TextStyle(color: Color(0xffa15d48)),
              ),
            ),
          ),
      ],
    ),
  );

  Widget _optionsView() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      TextButton.icon(
        onPressed: () => setState(() {
          _showOptions = false;
        }),
        icon: const Icon(Icons.arrow_back, size: 16),
        label: const Text('All secrets'),
      ),
      const SizedBox(height: 12),
      _title('Your vault.'),
      Text(_account!.email, style: const TextStyle(color: Color(0xff899681))),
      const SizedBox(height: 20),
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.sync),
        title: const Text('Sync now'),
        onTap: () => _sync(manual: true),
      ),
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.lock_outline),
        title: const Text('Lock vault'),
        onTap: () {
          _cover();
          setState(() {});
        },
      ),
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.logout),
        title: const Text('Sign out'),
        onTap: _signOut,
      ),
      const SizedBox(height: 20),
      const Text(
        'Google opens this vault. Supabase manages the encryption key. The same account opens the same secrets in Chrome.',
        style: TextStyle(fontSize: 12, height: 1.6, color: Color(0xff899681)),
      ),
      const SizedBox(height: 12),
      const Text(
        'Locks in the background and after 2 minutes of inactivity. Copied secrets stay on your clipboard until replaced.',
        style: TextStyle(fontSize: 12, height: 1.6, color: Color(0xff899681)),
      ),
    ],
  );
}

class LinkedNote extends StatefulWidget {
  const LinkedNote({super.key, required this.text});
  final String text;
  @override
  State<LinkedNote> createState() => _LinkedNoteState();
}

class _LinkedNoteState extends State<LinkedNote> {
  final _recognizers = <TapGestureRecognizer>[];
  void _clear() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();
  }

  @override
  void dispose() {
    _clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _clear();
    final spans = <InlineSpan>[];
    var offset = 0;
    for (final match in RegExp(
      r'''https?://[^\s<>"']+''',
      caseSensitive: false,
    ).allMatches(widget.text)) {
      final uri = Uri.tryParse(match.group(0)!);
      if (uri == null ||
          !['http', 'https'].contains(uri.scheme.toLowerCase()) ||
          uri.host.isEmpty) {
        continue;
      }
      spans.add(TextSpan(text: widget.text.substring(offset, match.start)));
      final recognizer = TapGestureRecognizer()
        ..onTap = () async {
          try {
            if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
                context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Could not open this link.')),
              );
            }
          } catch (_) {
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Could not open this link.')),
              );
            }
          }
        };
      _recognizers.add(recognizer);
      spans.add(
        TextSpan(
          text: match.group(0),
          style: const TextStyle(
            color: green,
            decoration: TextDecoration.underline,
          ),
          recognizer: recognizer,
        ),
      );
      offset = match.end;
    }
    spans.add(TextSpan(text: widget.text.substring(offset)));
    return Text.rich(
      TextSpan(children: spans),
      style: const TextStyle(
        fontSize: 12,
        height: 1.5,
        color: Color(0xff899681),
      ),
    );
  }
}
