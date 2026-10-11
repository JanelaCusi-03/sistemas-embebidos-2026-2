"""
Lambda única que atiende las 3 rutas de API Gateway (REST, integración proxy):

  POST /location                -> el celular envía su posición (ingesta)
  GET  /devices                 -> lista de celulares con su última posición
  GET  /locations/{device_id}   -> historial de posiciones de un celular
                                   (?limit=100&from=ISO&to=ISO)

Tablas DynamoDB:
  Devices   (PK: device_id)
  Locations (PK: device_id, SK: timestamp)
"""
import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

# Recursos de DynamoDB (los nombres se pueden cambiar con variables de entorno)
dynamodb = boto3.resource("dynamodb")
devices_table = dynamodb.Table(os.environ.get("DEVICES_TABLE", "Devices"))
locations_table = dynamodb.Table(os.environ.get("LOCATIONS_TABLE", "Locations"))

# Cabeceras CORS: necesarias para que el dashboard web pueda llamar a la API
HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


def _json_default(obj):
    """DynamoDB devuelve números como Decimal; json no sabe serializarlos."""
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps(body, default=_json_default),
    }


def _dec(value):
    """float -> Decimal (DynamoDB no acepta float)."""
    return Decimal(str(value))


def lambda_handler(event, context):
    method = event.get("httpMethod")
    resource = event.get("resource", "")

    if method == "OPTIONS":                       # preflight CORS
        return _resp(200, {})
    if method == "POST" and resource in ("/location", "/locations"):
        return save_location(event)
    if method == "GET" and resource == "/devices":
        return list_devices()
    if method == "GET" and resource == "/locations/{device_id}":
        return get_locations(event)
    return _resp(404, {"error": "Ruta no encontrada"})


# ---------------------------------------------------------------- POST
def save_location(event):
    """Valida el JSON recibido y guarda posición + actualiza el dispositivo."""
    try:
        data = json.loads(event.get("body") or "{}")
        device_id = str(data["device_id"]).strip()
        lat = float(data["lat"])
        lon = float(data["lon"])
    except (KeyError, ValueError, TypeError):
        return _resp(400, {"error": "Se requieren device_id, lat y lon válidos"})

    # Rangos válidos del sistema WGS84
    if not device_id or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return _resp(400, {"error": "Coordenadas fuera de rango"})

    # Si el celular no manda hora, se usa la del servidor (UTC, ISO 8601)
    ts = data.get("timestamp") or datetime.now(timezone.utc).isoformat()

    item = {
        "device_id": device_id,
        "timestamp": ts,
        "lat": _dec(lat),
        "lon": _dec(lon),
        "accuracy": _dec(data.get("accuracy", 0)),
        "speed": _dec(data.get("speed", 0)),
        "battery": _dec(data.get("battery", -1)),
    }
    locations_table.put_item(Item=item)

    # Upsert en Devices: crea el celular si es nuevo y guarda su última posición
    # (desnormalizado a propósito: el mapa se carga con 1 sola consulta)
    devices_table.update_item(
        Key={"device_id": device_id},
        UpdateExpression=(
            "SET nombre = :n, "
            "fecha_registro = if_not_exists(fecha_registro, :ts), "
            "ultima_conexion = :ts, last_lat = :lat, last_lon = :lon, "
            "last_battery = :bat"
        ),
        ExpressionAttributeValues={
            ":n": data.get("nombre", device_id),
            ":ts": ts,
            ":lat": item["lat"],
            ":lon": item["lon"],
            ":bat": item["battery"],
        },
    )
    return _resp(201, {"ok": True, "device_id": device_id, "timestamp": ts})


# ---------------------------------------------------------------- GET
def list_devices():
    """Devuelve todos los celulares registrados (Scan: tabla pequeña)."""
    items = devices_table.scan().get("Items", [])
    return _resp(200, items)


def get_locations(event):
    """Historial de un celular, SIEMPRE en orden cronológico (antiguo -> nuevo).
    Parámetros: from, to (ISO UTC), step (toma 1 de cada N puntos), limit (máx 20000).
    Sin 'from' devuelve los últimos N puntos."""
    device_id = event["pathParameters"]["device_id"]
    qs = event.get("queryStringParameters") or {}
    limit = min(int(qs.get("limit", 100)), 20000)
    step = max(int(qs.get("step", 1)), 1)
    frm, to = qs.get("from"), qs.get("to")

    cond = Key("device_id").eq(device_id)
    if frm and to:
        cond = cond & Key("timestamp").between(frm, to)
    elif frm:
        cond = cond & Key("timestamp").gte(frm)
    elif to:
        cond = cond & Key("timestamp").lte(to)

    ascending = bool(frm)                      # con 'from' leemos hacia adelante
    kwargs = {"KeyConditionExpression": cond, "ScanIndexForward": ascending,
              "Limit": min(limit * step, 1000)}
    items, n = [], 0
    while True:                                # paginación (DynamoDB entrega máx. 1 MB por consulta)
        res = locations_table.query(**kwargs)
        for it in res["Items"]:
            if n % step == 0:
                items.append(it)
            n += 1
            if len(items) >= limit:
                break
        if len(items) >= limit or "LastEvaluatedKey" not in res:
            break
        kwargs["ExclusiveStartKey"] = res["LastEvaluatedKey"]
    if not ascending:
        items.reverse()
    return _resp(200, items)
