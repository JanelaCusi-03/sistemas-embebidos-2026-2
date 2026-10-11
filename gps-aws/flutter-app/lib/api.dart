import 'dart:convert';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';
import 'config.dart';

// ---------- utilidades ----------
/// Fecha en ISO UTC con milisegundos (mismo formato que se guarda en DynamoDB)
String isoUtc(DateTime d) =>
    DateTime.fromMillisecondsSinceEpoch(d.millisecondsSinceEpoch, isUtc: true).toIso8601String();
DateTime inicioDia(DateTime d) => DateTime(d.year, d.month, d.day);
bool mismoDia(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
String dos(int n) => n.toString().padLeft(2, '0');
String fmtFecha(DateTime d) => '${dos(d.day)}/${dos(d.month)}/${d.year}';
String fmtHora(int h, int m) => '${dos(h)}:${dos(m)}';
String fmtDur(Duration d) => d.inHours > 0
    ? '${d.inHours} h ${dos(d.inMinutes % 60)} min'
    : d.inMinutes > 0 ? '${d.inMinutes} min' : '${d.inSeconds} s';

const _dist = Distance();

/// Ruta que acumula kilómetros. Ignora movimientos < 3 m (ruido del GPS cuando estás quieto).
class Ruta {
  final List<LatLng> puntos = [];
  double km = 0;
  void agregar(LatLng p) {
    if (puntos.isNotEmpty) {
      final m = _dist.as(LengthUnit.Meter, puntos.last, p);
      if (m <= 3) return;
      km += m / 1000;
    }
    puntos.add(p);
  }

  void limpiar() {
    puntos.clear();
    km = 0;
  }
}

class PuntoGps {
  final double lat, lon, speed, accuracy;
  final DateTime t;
  PuntoGps(this.lat, this.lon, this.speed, this.accuracy, this.t);
  LatLng get latLng => LatLng(lat, lon);
  factory PuntoGps.fromJson(Map<String, dynamic> j) => PuntoGps(
        (j['lat'] as num).toDouble(),
        (j['lon'] as num).toDouble(),
        (j['speed'] as num?)?.toDouble() ?? 0,
        (j['accuracy'] as num?)?.toDouble() ?? 0,
        DateTime.parse(j['timestamp'] as String).toLocal(),
      );
}

// ---------- cliente de la API REST (API Gateway) ----------
class Api {
  /// Envía la posición actual (POST /location)
  static Future<int> enviar(String id, String nombre, Position p, int bateria) async {
    final r = await http
        .post(Uri.parse('$kApiUrl/locations'),
            headers: {'Content-Type': 'application/json', 'x-api-key': kApiKey},
            body: jsonEncode({
              'device_id': id,
              'nombre': nombre,
              'lat': p.latitude,
              'lon': p.longitude,
              'accuracy': p.accuracy,
              'speed': p.speed < 0 ? 0 : p.speed,
              'battery': bateria,
              'timestamp': isoUtc(DateTime.now()),
            }))
        .timeout(const Duration(seconds: 6));
    return r.statusCode; // 201 = guardado
  }

  /// Historial de este celular (GET /locations/{id}) entre dos fechas
  static Future<List<PuntoGps>> puntos(String id, {DateTime? desde, DateTime? hasta, int step = 1}) async {
    final q = {'limit': '20000', 'step': '$step'};
    if (desde != null) q['from'] = isoUtc(desde);
    if (hasta != null) q['to'] = isoUtc(hasta);
    final uri = Uri.parse('$kApiUrl/locations/$id').replace(queryParameters: q);
    final r = await http.get(uri, headers: {'x-api-key': kApiKey}).timeout(const Duration(seconds: 25));
    if (r.statusCode != 200) throw Exception('HTTP ${r.statusCode}');
    return (jsonDecode(r.body) as List).map((e) => PuntoGps.fromJson(e as Map<String, dynamic>)).toList();
  }
}
