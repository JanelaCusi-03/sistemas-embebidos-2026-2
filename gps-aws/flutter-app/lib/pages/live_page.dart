import 'dart:async';
import 'package:battery_plus/battery_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api.dart';
import '../config.dart';
import '../ui.dart';
import 'history_page.dart';

enum Estado { pausado, buscando, enVivo, sinRed, sinGps }

/// Mapa en vivo: tu posición + el recorrido de HOY (se reinicia a las 00:00).
class LivePage extends StatefulWidget {
  final String deviceId, nombre;
  const LivePage({super.key, required this.deviceId, required this.nombre});
  @override
  State<LivePage> createState() => _LivePageState();
}

class _LivePageState extends State<LivePage> {
  final _map = MapController();
  final _key = GlobalKey<ScaffoldState>();
  final _bat = Battery();
  StreamSubscription<Position>? _sub;

  bool _mapaListo = false, _seguir = true, _compartir = true, _enviando = false;
  Estado _estado = Estado.buscando;
  Position? _pos;
  final Ruta _hoy = Ruta();
  DateTime _dia = DateTime.now(), _ultEnvio = DateTime(2000), _ultBat = DateTime(2000);
  int _bateria = -1;
  String _detalle = ''; // motivo del último fallo de envío

  @override
  void initState() {
    super.initState();
    _arrancar();
  }

  Future<void> _arrancar() async {
    final p = await SharedPreferences.getInstance();
    _compartir = p.getBool('compartir') ?? true;
    if (_compartir) {
      _iniciarGps(); // ¡el GPS se activa solo al registrarte!
    } else {
      setState(() => _estado = Estado.pausado);
    }
    _cargarHoy();
  }

  /// Recorrido de hoy guardado en AWS (así no se pierde si cierras la app)
  Future<void> _cargarHoy() async {
    try {
      final pts = await Api.puntos(widget.deviceId, desde: inicioDia(DateTime.now()), step: 3);
      if (!mounted) return;
      final vivos = List<LatLng>.from(_hoy.puntos); // puntos tomados mientras cargaba
      setState(() {
        _hoy.limpiar();
        for (final p in pts) {
          if (p.accuracy <= 40) _hoy.agregar(p.latLng);
        }
        vivos.forEach(_hoy.agregar);
      });
    } catch (_) {}
  }

  Future<void> _iniciarGps() async {
    await _sub?.cancel();
    if (!await Geolocator.isLocationServiceEnabled()) {
      setState(() => _estado = Estado.sinGps);
      _aviso('Android no deja encender el GPS solo. Pulsa «Activar» 📡', Geolocator.openLocationSettings);
      return;
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      setState(() => _estado = Estado.sinGps);
      _aviso('Falta el permiso de ubicación', Geolocator.openAppSettings);
      return;
    }
    // Servicio en primer plano: sigue enviando con la pantalla apagada
    final cfg = AndroidSettings(
      accuracy: LocationAccuracy.best,
      distanceFilter: 0,
      intervalDuration: const Duration(seconds: kIntervaloSegundos),
      foregroundNotificationConfig: const ForegroundNotificationConfig(
        notificationTitle: 'GPS Tracker activo 🐾',
        notificationText: 'Compartiendo tu ubicación',
        enableWakeLock: true,
      ),
    );
    _sub = Geolocator.getPositionStream(locationSettings: cfg).listen(_onPos,
        onError: (_) => setState(() => _estado = Estado.sinGps));
    setState(() => _estado = Estado.buscando);
    try {
      final u = await Geolocator.getLastKnownPosition(); // punto inmediato mientras llega el GPS
      if (u != null && _pos == null) _onPos(u, enviar: false);
    } catch (_) {}
  }

  void _aviso(String txt, VoidCallback accion) => ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(txt), action: SnackBarAction(label: 'Activar', onPressed: accion)));

  /// Cada lectura del GPS: dibuja al instante (sin red) y envía a AWS.
  void _onPos(Position p, {bool enviar = true}) {
    final ahora = DateTime.now();
    final punto = LatLng(p.latitude, p.longitude);
    setState(() {
      if (!mismoDia(_dia, ahora)) {
        _dia = ahora; // pasó la medianoche: el recorrido se reinicia
        _hoy.limpiar();
      }
      _pos = p;
      if (p.accuracy <= 40) _hoy.agregar(punto);
    });
    if (_seguir && _mapaListo) _map.move(punto, _map.camera.zoom);
    if (enviar) _enviar(p);
  }

  Future<void> _enviar(Position p) async {
    if (_enviando) return; // no acumular envíos si la red va lenta
    _enviando = true;
    try {
      if (DateTime.now().difference(_ultBat).inSeconds > 30) {
        _bateria = await _bat.batteryLevel;
        _ultBat = DateTime.now();
      }
      final code = await Api.enviar(widget.deviceId, widget.nombre, p, _bateria);
      if (mounted) {
        setState(() {
          if (code == 201) {
            _estado = Estado.enVivo;
            _detalle = '';
          } else {
            _estado = Estado.sinRed;
            _detalle = code == 403
                ? 'ruta o clave de la API incorrecta (403)'
                : code == 500 ? 'error dentro de la Lambda (500)' : 'la API respondió $code';
          }
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _estado = Estado.sinRed;
          _detalle = 'sin internet o URL de la API incorrecta';
        });
      }
    } finally {
      _enviando = false;
    }
  }

  Future<void> _alternar(bool v) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('compartir', v);
    setState(() => _compartir = v);
    if (v) {
      _iniciarGps();
    } else {
      await _sub?.cancel();
      setState(() => _estado = Estado.pausado);
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pos = _pos == null ? null : LatLng(_pos!.latitude, _pos!.longitude);
    final vel = ((_pos?.speed ?? 0) * 3.6).clamp(0, 999).toStringAsFixed(1);
    const etiquetas = {
      Estado.enVivo: '🟢 En vivo · compartiendo',
      Estado.buscando: '🟡 Buscando señal GPS…',
      Estado.pausado: '⏸️ Ubicación en pausa',
      Estado.sinRed: '🔴 Sin conexión · reintentando',
      Estado.sinGps: '📵 Activa el GPS y los permisos',
    };
    return Scaffold(
      key: _key,
      drawer: _menu(),
      body: Stack(children: [
        FlutterMap(
          mapController: _map,
          options: MapOptions(
            initialCenter: const LatLng(-13.5319, -71.9675),
            initialZoom: 17,
            onMapReady: () {
              _mapaListo = true;
              if (pos != null) _map.move(pos, 17);
            },
            // si mueves el mapa con el dedo, deja de seguirte
            onPositionChanged: (c, gesto) {
              if (gesto && _seguir) setState(() => _seguir = false);
            },
          ),
          children: [
            TileLayer(urlTemplate: kTileUrl, userAgentPackageName: 'com.example.gps_tracker'),
            // OJO: flutter_map falla con líneas vacías, por eso se exige >= 2 puntos
            if (_hoy.puntos.length >= 2)
              PolylineLayer(polylines: [
                Polyline(points: _hoy.puntos, strokeWidth: 6, color: K.rosa, borderStrokeWidth: 2, borderColor: Colors.white),
              ]),
            MarkerLayer(markers: [
              if (_hoy.puntos.isNotEmpty)
                Marker(point: _hoy.puntos.first, width: 36, height: 36, child: const Center(child: Text('🚩', style: TextStyle(fontSize: 24)))),
              if (pos != null)
                Marker(
                  point: pos,
                  width: 30,
                  height: 30,
                  child: Container(
                    decoration: BoxDecoration(
                      color: K.lila,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 4),
                      boxShadow: const [BoxShadow(color: Color(0x668A6FD0), blurRadius: 12, spreadRadius: 4)],
                    ),
                  ),
                ),
            ]),
          ],
        ),
        // barra superior: menú + estado
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              botonRedondo(Icons.menu_rounded, () => _key.currentState?.openDrawer()),
              const SizedBox(width: 10),
              Expanded(
                child: KCard(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: Text(etiquetas[_estado]! + (_estado == Estado.sinRed && _detalle.isNotEmpty ? '\n($_detalle)' : ''), style: const TextStyle(fontWeight: FontWeight.w700, color: K.tinta)),
                ),
              ),
            ]),
          ),
        ),
        // panel inferior: estadísticas del día
        Align(
          alignment: Alignment.bottomCenter,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                botonRedondo(_seguir ? Icons.my_location : Icons.location_searching, () {
                  setState(() => _seguir = true);
                  if (pos != null) _map.move(pos, 17);
                }),
                const SizedBox(height: 10),
                KCard(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Row(children: [
                      Text('📅 Hoy ${fmtFecha(_dia)}', style: const TextStyle(fontWeight: FontWeight.w800, color: K.tinta)),
                      const Spacer(),
                      const Text('se reinicia 00:00 🌙', style: TextStyle(fontSize: 12, color: K.suave)),
                    ]),
                    const SizedBox(height: 12),
                    Row(children: [
                      Expanded(child: Stat('🐾', _hoy.km.toStringAsFixed(2), 'km hoy', K.rosaL)),
                      const SizedBox(width: 10),
                      Expanded(child: Stat('💨', vel, 'km/h', K.mentaL)),
                      const SizedBox(width: 10),
                      Expanded(child: Stat('🎯', _pos == null ? '--' : '±${_pos!.accuracy.round()}', 'metros', K.lilaL)),
                    ]),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ]),
    );
  }

  /// Menú lateral (esquina superior izquierda)
  Widget _menu() => Drawer(
        backgroundColor: K.crema,
        child: SafeArea(
          child: Column(children: [
            Container(
              margin: const EdgeInsets.all(16),
              padding: const EdgeInsets.all(20),
              width: double.infinity,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(28),
                gradient: const LinearGradient(colors: [K.rosa, K.lila]),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('🐰', style: TextStyle(fontSize: 38)),
                Text(widget.nombre, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
                Text(widget.deviceId, style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ]),
            ),
            ListTile(
                leading: const Text('🗺️', style: TextStyle(fontSize: 24)),
                title: const Text('Mapa en vivo', style: TextStyle(fontWeight: FontWeight.w700)),
                onTap: () => Navigator.pop(context)),
            ListTile(
              leading: const Text('📅', style: TextStyle(fontSize: 24)),
              title: const Text('Mi registro', style: TextStyle(fontWeight: FontWeight.w700)),
              subtitle: const Text('Busca por día y por horas'),
              onTap: () {
                Navigator.pop(context);
                Navigator.push(context, MaterialPageRoute(builder: (_) => HistoryPage(deviceId: widget.deviceId)));
              },
            ),
            SwitchListTile(
              secondary: const Text('📡', style: TextStyle(fontSize: 24)),
              title: const Text('Compartir ubicación', style: TextStyle(fontWeight: FontWeight.w700)),
              value: _compartir,
              onChanged: _alternar,
            ),
          ]),
        ),
      );
}
