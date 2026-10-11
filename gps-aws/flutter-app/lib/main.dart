import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import 'pages/live_page.dart';
import 'ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'GPS Tracker',
        debugShowCheckedModeBanner: false,
        theme: kTheme(),
        locale: const Locale('es'),
        supportedLocales: const [Locale('es'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const Root(),
      );
}

/// Decide qué pantalla mostrar: registro (primera vez) o mapa en vivo.
class Root extends StatefulWidget {
  const Root({super.key});
  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> {
  String _id = '', _nombre = '';
  bool? _registrado;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final p = await SharedPreferences.getInstance();
    var id = p.getString('device_id');
    if (id == null) {
      id = 'cel-${const Uuid().v4().substring(0, 8)}'; // ID único del celular
      await p.setString('device_id', id);
    }
    setState(() {
      _id = id!;
      _nombre = p.getString('nombre') ?? '';
      _registrado = p.getBool('registrado') ?? false;
    });
  }

  Future<void> _registrar(String nombre) async {
    final p = await SharedPreferences.getInstance();
    await p.setString('nombre', nombre);
    await p.setBool('registrado', true);
    setState(() {
      _nombre = nombre;
      _registrado = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_registrado == null) {
      return const Scaffold(body: Center(child: Text('🐾', style: TextStyle(fontSize: 64))));
    }
    if (_registrado!) return LivePage(deviceId: _id, nombre: _nombre);
    return RegisterPage(deviceId: _id, onRegistrar: _registrar);
  }
}

/// Pantalla de registro: al registrarte se activa el GPS y apareces en la web.
class RegisterPage extends StatefulWidget {
  final String deviceId;
  final Future<void> Function(String) onRegistrar;
  const RegisterPage({super.key, required this.deviceId, required this.onRegistrar});
  @override
  State<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends State<RegisterPage> {
  final _ctrl = TextEditingController();
  bool _cargando = false;

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
                begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [K.rosaL, K.lilaL, K.mentaL]),
          ),
          child: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: Column(children: [
                  const Text('🐾', style: TextStyle(fontSize: 72)),
                  const Text('¡Hola!', style: TextStyle(fontSize: 34, fontWeight: FontWeight.w800, color: K.tinta)),
                  const SizedBox(height: 6),
                  const Text('Registra tu celular y empezaremos a compartir tu ubicación 📍',
                      textAlign: TextAlign.center, style: TextStyle(color: K.suave)),
                  const SizedBox(height: 26),
                  KCard(
                    child: Column(children: [
                      TextField(
                        controller: _ctrl,
                        textCapitalization: TextCapitalization.words,
                        decoration: InputDecoration(
                          hintText: 'Ej: Celular de Jose',
                          filled: true,
                          fillColor: K.lilaL,
                          prefixIcon: const Icon(Icons.phone_android_rounded),
                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(20), borderSide: BorderSide.none),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text('ID: ${widget.deviceId}', style: const TextStyle(fontSize: 12, color: K.suave)),
                      const SizedBox(height: 14),
                      FilledButton(
                        style: FilledButton.styleFrom(
                            backgroundColor: K.rosa,
                            foregroundColor: Colors.white,
                            minimumSize: const Size.fromHeight(54),
                            shape: const StadiumBorder(),
                            textStyle: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                        onPressed: _cargando
                            ? null
                            : () async {
                                final n = _ctrl.text.trim();
                                if (n.isEmpty) return;
                                setState(() => _cargando = true);
                                await widget.onRegistrar(n);
                              },
                        child: Text(_cargando ? 'Registrando…' : 'Registrarme y activar GPS 📡'),
                      ),
                    ]),
                  ),
                ]),
              ),
            ),
          ),
        ),
      );
}
