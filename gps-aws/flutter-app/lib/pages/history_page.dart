import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../api.dart';
import '../config.dart';
import '../ui.dart';

/// Registro: busca tu recorrido por día y por rango de horas.
class HistoryPage extends StatefulWidget {
  final String deviceId;
  const HistoryPage({super.key, required this.deviceId});
  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  final _map = MapController();
  bool _mapaListo = false, _cargando = false;
  DateTime _fecha = DateTime.now();
  TimeOfDay _ini = const TimeOfDay(hour: 0, minute: 0), _fin = const TimeOfDay(hour: 23, minute: 59);
  Ruta _ruta = Ruta();
  Duration _dur = Duration.zero;
  double _vMax = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _buscar();
  }

  Future<void> _buscar() async {
    final desde = DateTime(_fecha.year, _fecha.month, _fecha.day, _ini.hour, _ini.minute);
    final hasta = DateTime(_fecha.year, _fecha.month, _fecha.day, _fin.hour, _fin.minute, 59);
    if (!hasta.isAfter(desde)) {
      setState(() => _error = 'La hora final debe ser mayor que la inicial ⏰');
      return;
    }
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      // rangos largos se muestrean (1 de cada N puntos) para no saturar el celular
      var step = (hasta.difference(desde).inSeconds / 10000).ceil();
      if (step < 1) step = 1;
      final pts = await Api.puntos(widget.deviceId, desde: desde, hasta: hasta, step: step);
      final r = Ruta();
      double vmax = 0;
      for (final p in pts) {
        if (p.accuracy <= 40) r.agregar(p.latLng);
        if (p.speed > vmax) vmax = p.speed;
      }
      if (!mounted) return;
      setState(() {
        _ruta = r;
        _vMax = vmax * 3.6;
        _dur = pts.length > 1 ? pts.last.t.difference(pts.first.t) : Duration.zero;
        if (pts.isEmpty) _error = 'No hay recorrido en ese horario 🐣';
      });
      if (_mapaListo) _ajustar();
    } catch (e) {
      if (mounted) setState(() => _error = 'No se pudo cargar ($e) 😿');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  /// Encuadra el mapa (solo si hay puntos: flutter_map falla con listas vacías)
  void _ajustar() {
    final p = _ruta.puntos;
    if (p.isEmpty) return;
    if (p.length == 1) {
      _map.move(p.first, 17);
    } else {
      _map.fitCamera(CameraFit.coordinates(coordinates: p, padding: const EdgeInsets.all(48), maxZoom: 18));
    }
  }

  Future<void> _elegirFecha() async {
    final f = await showDatePicker(context: context, initialDate: _fecha, firstDate: DateTime(2024), lastDate: DateTime.now());
    if (f != null) setState(() => _fecha = f);
  }

  Future<void> _elegirHora(bool inicio) async {
    final t = await showTimePicker(context: context, initialTime: inicio ? _ini : _fin);
    if (t != null) setState(() => inicio ? _ini = t : _fin = t);
  }

  @override
  Widget build(BuildContext context) {
    final p = _ruta.puntos;
    final horas = _dur.inSeconds / 3600;
    return Scaffold(
      appBar: AppBar(
        title: const Text('📅 Mi registro', style: TextStyle(fontWeight: FontWeight.w800, color: K.tinta)),
        backgroundColor: K.crema,
        centerTitle: true,
      ),
      body: Column(children: [
        Expanded(
          child: FlutterMap(
            mapController: _map,
            options: MapOptions(
              initialCenter: const LatLng(-13.5319, -71.9675),
              initialZoom: 15,
              onMapReady: () {
                _mapaListo = true;
                _ajustar();
              },
            ),
            children: [
              TileLayer(urlTemplate: kTileUrl, userAgentPackageName: 'com.example.gps_tracker'),
              if (p.length >= 2)
                PolylineLayer(polylines: [Polyline(points: p, strokeWidth: 6, color: K.rosa, borderStrokeWidth: 2, borderColor: Colors.white)]),
              MarkerLayer(markers: [
                if (p.isNotEmpty) Marker(point: p.first, width: 36, height: 36, child: const Center(child: Text('🚩', style: TextStyle(fontSize: 24)))),
                if (p.length > 1) Marker(point: p.last, width: 36, height: 36, child: const Center(child: Text('🏁', style: TextStyle(fontSize: 24)))),
              ]),
            ],
          ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
            boxShadow: [BoxShadow(color: Color(0x228A6FD0), blurRadius: 20)],
          ),
          child: SafeArea(
            top: false,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
                pill('📅 ${fmtFecha(_fecha)}', _elegirFecha),
                pill('🌅 ${fmtHora(_ini.hour, _ini.minute)}', () => _elegirHora(true), color: K.mentaL),
                pill('🌙 ${fmtHora(_fin.hour, _fin.minute)}', () => _elegirHora(false), color: K.rosaL),
                pill('Hoy', () => setState(() => _fecha = DateTime.now())),
                pill('Ayer', () => setState(() => _fecha = DateTime.now().subtract(const Duration(days: 1)))),
              ]),
              const SizedBox(height: 12),
              FilledButton(
                style: FilledButton.styleFrom(
                    backgroundColor: K.rosa, foregroundColor: Colors.white, minimumSize: const Size.fromHeight(50), shape: const StadiumBorder()),
                onPressed: _cargando ? null : _buscar,
                child: Text(_cargando ? 'Buscando…' : 'Buscar recorrido 🔍', style: const TextStyle(fontWeight: FontWeight.w800)),
              ),
              const SizedBox(height: 12),
              if (_error != null)
                Text(_error!, style: const TextStyle(color: K.suave))
              else
                Row(children: [
                  Expanded(child: Stat('🐾', _ruta.km.toStringAsFixed(2), 'km', K.rosaL)),
                  const SizedBox(width: 8),
                  Expanded(child: Stat('⏱️', fmtDur(_dur), 'duración', K.mentaL)),
                  const SizedBox(width: 8),
                  Expanded(child: Stat('💨', (horas > 0 ? _ruta.km / horas : 0).toStringAsFixed(1), 'km/h prom.', K.lilaL)),
                  const SizedBox(width: 8),
                  Expanded(child: Stat('🚀', _vMax.toStringAsFixed(0), 'km/h máx.', K.rosaL)),
                ]),
            ]),
          ),
        ),
      ]),
    );
  }
}
