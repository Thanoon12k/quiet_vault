import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quiet_vault/app.dart';
import 'package:quiet_vault/data/storage.dart';
import 'package:quiet_vault/data/vault_crypto.dart';
import 'package:quiet_vault/demo.dart';

Json fixture() => Map<String, dynamic>.from(
  jsonDecode(File('test/fixtures/chrome_vault.json').readAsStringSync()) as Map,
);
Future<void> screenshot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(const Key('capture')),
    );
    final image = await boundary.toImage(pixelRatio: 2);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('build/previews/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    final material = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await material.load();
    if (Platform.isWindows) {
      final path =
          '${Platform.environment['WINDIR'] ?? 'C:/Windows'}/Fonts/segoeui.ttf';
      final font = FontLoader(
        'Roboto',
      )..addFont(File(path).readAsBytes().then((x) => ByteData.sublistView(x)));
      await font.load();
    }
  });
  testWidgets('Google is the only sign-in control', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 780));
    final auth = DemoAuth(signedIn: false);
    await tester.pumpWidget(
      RepaintBoundary(
        key: const Key('capture'),
        child: QuietVaultApp(
          auth: auth,
          backend: DemoBackend(fixture()),
          storage: MemoryStorage(),
        ),
      ),
    );
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    await screenshot(tester, 'quiet-vault-mobile-signin');
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'single compact form, optional link, copy, edit, background cover and reopen',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 780));
      final backend = DemoBackend(fixture());
      await tester.pumpWidget(
        RepaintBoundary(
          key: const Key('capture'),
          child: QuietVaultApp(
            auth: DemoAuth(),
            backend: backend,
            storage: MemoryStorage(),
            demo: true,
          ),
        ),
      );
      // Real WebCrypto-compatible PBKDF2 runs outside the fake test clock.
      await tester.runAsync(() async {
        for (
          var i = 0;
          i < 600 && find.text('OpenAI · personal').evaluate().isEmpty;
          i++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          await tester.pump();
        }
      });
      await tester.pumpAndSettle();
      expect(find.text('OpenAI · personal'), findsOneWidget);
      await screenshot(tester, 'quiet-vault-mobile-home');
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String;
        return null;
      });
      await tester.tap(find.byTooltip('Copy OpenAI · personal'));
      await tester.pumpAndSettle();
      expect(copied, 'DEMO_ONLY_not_a_real_api_key');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
      await tester.enterText(find.byKey(const Key('search')), 'My new key');
      await tester.pump();
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
      expect(find.text('My new key'), findsOneWidget);
      expect(find.text('Continue'), findsNothing);
      expect(find.byType(TextFormField), findsNWidgets(2));
      await tester.enterText(
        find.byType(TextFormField).first,
        'dummy-new-value',
      );
      await tester.enterText(
        find.byType(TextFormField).last,
        'https://example.invalid/keys',
      );
      tester.testTextInput.hide();
      await tester.pump();
      await screenshot(tester, 'quiet-vault-mobile-add');
      await tester.tap(find.text('Save secret'));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(seconds: 1));
      });
      await tester.pumpAndSettle();
      expect(find.text('My new key'), findsOneWidget);
      expect(find.text('dummy-new-value'), findsNothing);
      await tester.tap(find.text('My new key'));
      await tester.pumpAndSettle();
      expect(find.text('Save changes'), findsOneWidget);
      for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused,
        AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
      await tester.pumpAndSettle();
      expect(find.text('dummy-new-value'), findsNothing);
      expect(find.text('Open vault'), findsOneWidget);
      expect(find.byType(TextFormField), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
