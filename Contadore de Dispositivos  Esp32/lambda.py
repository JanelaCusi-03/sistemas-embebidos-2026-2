"""
Lambda del escáner ESP32  (Function URL)

GET            -> equipos vistos recientemente (lo que lee index.html, igual que antes)
GET ?redes=1   -> redes WiFi cercanas (SSID, BSSID, canal, RSSI, distancia)
GET ?debug=1   -> diagnóstico
POST           -> el ESP32 envía {"equipos":[...], "redes":[...]}

Las redes se guardan en la misma tabla "equipos" con la clave ip = "red:<BSSID>",
así no hay que crear otra tabla ni cambiar permisos. El GET normal las excluye.

Variables de entorno (opcionales, Configuration > Environment variables):
  TABLA         nombre de la tabla DynamoDB          (por defecto "equipos")
  TOKEN         clave que el ESP32 manda en el header "x-token"; si está vacía no se pide
  RSSI_1M       RSSI medido a 1 metro (calibración)   (por defecto -40)
  N_ENTORNO     exponente de pérdida del entorno      (por defecto 2.2)
  VENTANA_SEG   solo se devuelven equipos vistos en estos segundos (por defecto 120)
  TTL_SEG       DynamoDB borra solo los registros más viejos que esto (por defecto 3600)
  BUSCAR_FABRICANTE  "1" para consultar macvendors.com si falta "modelo" (por defecto "1")
"""
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr

tabla = boto3.resource("dynamodb").Table(os.environ.get("TABLA", "equipos"))

TOKEN = os.environ.get("TOKEN", "")
RSSI_1M = float(os.environ.get("RSSI_1M", "-40"))
N_ENTORNO = float(os.environ.get("N_ENTORNO", "2.2"))
VENTANA_SEG = int(os.environ.get("VENTANA_SEG", "120"))
TTL_SEG = int(os.environ.get("TTL_SEG", "3600"))
BUSCAR_FABRICANTE = os.environ.get("BUSCAR_FABRICANTE", "1") == "1"

# Cambia este texto cada vez que despliegues, para confirmar qué versión corre
VERSION = "2026-11-18-tipos"

# Campos internos que no se mandan a la web
OCULTOS = {"expira"}

# Equipos que tú conoces: MAC -> nombre que quieres ver en la web.
# Sirve para los celulares con MAC privada, que no dicen su nombre.
# La MAC la copias de la columna MAC de tu página.
CONOCIDOS = {
    # "E2:03:CF:9D:92:12": "Celular de Lizeth",
    # "DC:C2:C9:A5:CF:30": "Smart TV sala",
}

# Cache de fabricantes mientras la Lambda siga "caliente"
_fabricantes = {}
_consultas = 0          # consultas a macvendors en este envío (permite 1/seg)

PALABRAS_SOBRAN = {"co", "co.", "inc", "inc.", "ltd", "ltd.", "llc", "corp", "corp.",
                   "corporation", "corporate", "technologies", "technology",
                   "communications", "electronics", "limited", "gmbh", "s.a."}


# ---------------------------------------------------------------- utilidades
def _json(o):
    # DynamoDB devuelve Decimal: enteros como int, el resto como float
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(f"No serializable: {type(o)}")


def responder(codigo, cuerpo):
    # El CORS lo maneja la Function URL (no se agrega aquí)
    return {
        "statusCode": codigo,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store",
                    "X-Version": VERSION},
        "body": json.dumps(cuerpo, default=_json, ensure_ascii=False),
    }


def ahora_ms():
    return int(time.time() * 1000)


def a_ms(ts):
    """Acepta epoch en segundos o en milisegundos y lo deja en ms."""
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return 0
    if ts < 1e11:          # parece segundos (o millis() del ESP32, que no sirve)
        ts *= 1000
    return int(ts)


def distancia_por_rssi(rssi):
    """Modelo log-distance: d = 10 ^ ((RSSI(1m) - RSSI) / (10 n))"""
    d = 10 ** ((RSSI_1M - float(rssi)) / (10 * N_ENTORNO))
    return round(min(max(d, 0.001), 200), 3)   # hasta 3 decimales


def mac_aleatoria(mac):
    """Bit 'localmente administrada': 2.º carácter 2, 6, A o E -> MAC privada (típico de celulares)."""
    mac = str(mac or "").replace("-", ":").upper()
    return len(mac) >= 2 and mac[1] in "26AE"


def normalizar_mac(mac):
    mac = str(mac or "").strip().upper().replace("-", ":")
    return mac or None


PREFIJO_FAB = "fab:"      # los fabricantes ya consultados se guardan en la tabla
_cache_cargado = False


def cargar_fabricantes():
    """Lee de DynamoDB los fabricantes consultados antes (una vez por arranque)."""
    global _cache_cargado
    if _cache_cargado:
        return
    _cache_cargado = True
    try:
        kw = {"FilterExpression": Attr("ip").begins_with(PREFIJO_FAB)}
        resp = tabla.scan(**kw)
        while True:
            for it in resp["Items"]:
                _fabricantes[it["ip"][len(PREFIJO_FAB):]] = it.get("nombre") or None
            if "LastEvaluatedKey" not in resp:
                break
            resp = tabla.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **kw)
    except Exception as err:
        print("No pude leer fabricantes:", repr(err))


def recordar_fabricante(pref, nombre):
    _fabricantes[pref] = nombre
    try:
        tabla.put_item(Item={"ip": PREFIJO_FAB + pref, "nombre": nombre or ""})
    except Exception as err:
        print("No pude guardar fabricante:", repr(err))


def fabricante(mac):
    """Busca el fabricante por los 3 primeros bytes de la MAC (macvendors.com)."""
    global _consultas
    if not BUSCAR_FABRICANTE or not mac or mac_aleatoria(mac):
        return None
    pref = mac[:8]
    cargar_fabricantes()
    if pref in _fabricantes:
        return _fabricantes[pref]
    if _consultas >= 1:          # macvendors permite ~1 consulta por segundo:
        return None              # las demás se buscan en los próximos envíos
    _consultas += 1
    try:
        with urllib.request.urlopen("https://api.macvendors.com/" + pref, timeout=2) as r:
            texto = r.read().decode().split(",")[0]
            palabras = [w for w in texto.split() if w.lower() not in PALABRAS_SOBRAN]
            recordar_fabricante(pref, " ".join(palabras[:2]) or None)   # "HUAWEI TECHNOLOGIES CO.,LTD" -> "HUAWEI"
    except urllib.error.HTTPError as err:
        if err.code == 404:
            recordar_fabricante(pref, None)    # no existe: no volver a preguntar
    except Exception:
        pass                                   # error temporal: se reintenta en otro envío
    return _fabricantes.get(pref)


# ---------------------------------------------------------------- POST (ESP32)
PREFIJO_RED = "red:"


def es_red(e):
    return str(e.get("ip", "")).startswith(PREFIJO_RED)


def preparar_red(r, t):
    """Limpia una red WiFi cercana recibida del ESP32."""
    if not isinstance(r, dict) or not r.get("bssid"):
        return None
    bssid = normalizar_mac(r["bssid"])
    item = {
        "ip": PREFIJO_RED + bssid,        # clave de la tabla
        "bssid": bssid,
        "ssid": str(r.get("ssid") or "").strip()[:32] or "(red oculta)",
        "timestamp": t,
        "expira": t // 1000 + TTL_SEG,
    }
    for k in ("canal", "rssi", "seguridad"):
        if r.get(k) not in (None, ""):
            item[k] = r[k]
    if "rssi" in item:
        item["distancia"] = Decimal(str(distancia_por_rssi(item["rssi"])))
    return item
# Pistas para reconocer el tipo por el nombre del equipo o por su fabricante.
# Se revisan en este orden; la primera que coincide decide.
REGLAS_TIPO = [
    ("TV",        r"webos|smart.?tv|bravia|roku|chromecast|fire.?tv|android.?tv|google.?tv|"
                  r"tizen|vidaa|hisense|tcl|\btv\b|tv$"),
    ("Impresora", r"canon|epson|brother|seiko|laserjet|deskjet|officejet|printer|impresora|"
                  r"hewlett|\bhp\b|xerox|ricoh|kyocera|lexmark"),
    ("Router",    r"liwifi|tp-?link|tenda|mercusys|netgear|ubiquiti|mikrotik|d-?link|"
                  r"repeater|extender|repetidor|router|mesh"),
    ("Consola",   r"playstation|\bps[45]\b|xbox|nintendo|switch"),
    ("IoT",       r"espressif|tuya|shelly|sonoff|itead|broadlink|lg innotek|amazon|echo|"
                  r"alexa|nest|google home|ring|wyze|ezviz|hikvision|dahua|imou|raspberry"),
    ("Laptop",    r"laptop|notebook|desktop|macbook|thinkpad|ideapad|vivobook|\bpc\b|"
                  r"intel|liteon|azurewave|hon hai|realtek"),
    ("Móvil",     r"android|iphone|ipad|galaxy|redmi|poco|infinix|tecno|itel|pixel|oppo|"
                  r"vivo|realme|honor|moto|oneplus"),
]

NOMBRE_POR_TIPO = {"TV": "Televisor", "Impresora": "Impresora", "Router": "Repetidor WiFi",
                   "Consola": "Consola", "IoT": "Dispositivo inteligente", "Laptop": "Computadora",
                   "Móvil": "Celular"}


def tipo_por_pistas(nombre, modelo):
    texto = f"{nombre or ''} {modelo or ''}".lower()
    for tipo, patron in REGLAS_TIPO:
        if re.search(patron, texto):
            return tipo
    return None


def nombre_feo(n):
    """Nombres automáticos sin sentido, p. ej. 'cA5CF3000000' (impresoras Canon)."""
    n = str(n or "")
    return bool(re.fullmatch(r"[a-zA-Z]?[0-9A-Fa-f]{8,}", n))


def clasificar(e):
    """Deja cada equipo con un tipo y un nombre entendibles (sin 'Desconocido')."""
    mac, nombre, modelo = e.get("mac"), e.get("nombre"), e.get("modelo")
    if nombre_feo(nombre):
        nombre = None

    tipo = e.get("tipo")
    if tipo not in ("Router", "Laptop", "IoT") or not tipo:       # lo que el ESP32 ya sabe se respeta
        tipo = tipo_por_pistas(nombre, modelo) or tipo
    if not tipo and mac_aleatoria(mac):
        tipo = "Móvil"                     # MAC privada: casi siempre celular o tablet

    if not nombre:
        if mac_aleatoria(mac):
            nombre = "Celular (MAC privada)"
        elif tipo and modelo:
            nombre = f"{NOMBRE_POR_TIPO.get(tipo, tipo)} {modelo}"      # "Impresora Canon"
        elif modelo:
            nombre = modelo                                            # al menos la marca
        elif tipo in NOMBRE_POR_TIPO:
            nombre = NOMBRE_POR_TIPO[tipo]
        else:
            nombre = "Equipo sin identificar"

    e["tipo"] = tipo or "Otro"
    e["nombre"] = nombre
    return e


def preparar(e, t):
    """Limpia un equipo recibido del ESP32 antes de guardarlo."""
    if not isinstance(e, dict) or not e.get("ip"):
        return None
    e = {k: v for k, v in e.items() if v not in (None, "")}
    e["ip"] = str(e["ip"]).strip()
    if "mac" in e:
        e["mac"] = normalizar_mac(e["mac"])
    if e.get("mac") in CONOCIDOS:
        e["nombre"] = CONOCIDOS[e["mac"]]

    # Hora del servidor: el millis() del ESP32 no es una fecha real
    e["timestamp"] = t
    e["expira"] = t // 1000 + TTL_SEG     # para el TTL de DynamoDB

    if "distancia" not in e and "rssi" in e:
        e["distancia"] = Decimal(str(distancia_por_rssi(e["rssi"])))

    if not e.get("modelo"):
        f = fabricante(e.get("mac"))
        if f:
            e["modelo"] = f

    # Los nombres de CONOCIDOS siempre ganan; el resto se clasifica por pistas
    if e.get("mac") in CONOCIDOS:
        e.setdefault("tipo", tipo_por_pistas(e["nombre"], e.get("modelo")))
        if not e.get("tipo"):
            e.pop("tipo", None)
        return e
    return clasificar(e)


def guardar(event):
    global _consultas
    _consultas = 0
    if TOKEN:
        h = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        if h.get("x-token") != TOKEN:
            return responder(401, {"ok": False, "error": "token inválido"})

    cuerpo = event.get("body") or ""
    if event.get("isBase64Encoded"):
        cuerpo = base64.b64decode(cuerpo).decode()
    try:
        # parse_float=Decimal: DynamoDB no acepta float
        datos = json.loads(cuerpo, parse_float=Decimal)
    except json.JSONDecodeError:
        return responder(400, {"ok": False, "error": "JSON inválido"})

    # Acepta [{...}], {...} o {"equipos":[...], "redes":[...]}
    redes = []
    if isinstance(datos, dict):
        redes = datos.get("redes") or []
        if "equipos" in datos:
            datos = datos.get("equipos") or []
        elif "redes" in datos:
            datos = []
        else:
            datos = [datos]

    t = ahora_ms()
    equipos = [x for x in (preparar(e, t) for e in datos) if x]
    redes = [x for x in (preparar_red(r, t) for r in redes) if x]
    if not equipos and not redes:
        return responder(400, {"ok": False, "error": "no llegó ningún equipo ni red"})

    with tabla.batch_writer(overwrite_by_pkeys=["ip"]) as lote:
        for e in equipos + redes:
            lote.put_item(Item=e)
    return responder(200, {"ok": True, "guardados": len(equipos), "redes": len(redes)})


# ---------------------------------------------------------------- GET (web)
def listar(debug=False, solo_redes=False):
    ahora = ahora_ms()
    desde = ahora - VENTANA_SEG * 1000

    # Se lee todo y se filtra aquí, después de normalizar la hora
    # (así funciona aunque el timestamp esté en segundos, ms o como texto).
    # El TTL de DynamoDB mantiene la tabla pequeña.
    items, resp = [], tabla.scan()
    items += resp["Items"]
    while "LastEvaluatedKey" in resp:
        resp = tabla.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        items += resp["Items"]

    # Un solo registro por IP: el más reciente, y solo si es reciente
    ultimo = {}
    for e in items:
        ts = a_ms(e.get("timestamp", 0))
        if ts < desde or not e.get("ip"):
            continue
        if str(e["ip"]).startswith(PREFIJO_FAB):   # fabricantes guardados: no se muestran
            continue
        if es_red(e) != solo_redes:          # equipos y redes van por separado
            continue
        if e["ip"] not in ultimo or ts > ultimo[e["ip"]][0]:
            ultimo[e["ip"]] = (ts, e)

    salida = []
    for ts, e in ultimo.values():
        e = {k: v for k, v in e.items() if k not in OCULTOS}
        # "edad" = segundos desde que el ESP32 lo vio (reloj de AWS, no del navegador)
        e["edad"] = round(max(0, (ahora - ts) / 1000), 1)
        if e.get("distancia") is None and e.get("rssi") is not None:
            e["distancia"] = distancia_por_rssi(e["rssi"])
        if e.get("distancia") is not None:
            e["distancia"] = round(float(e["distancia"]), 3)
        salida.append(e)

    if solo_redes:
        for e in salida:
            e.pop("ip", None)                # la clave interna no se muestra
        salida.sort(key=lambda e: -float(e.get("rssi", -999)))   # la más cercana primero
    else:
        salida.sort(key=lambda e: [int(p) if p.isdigit() else 0 for p in str(e["ip"]).split(".")])
    print(f"listar: tabla={tabla.name} leidos={len(items)} devueltos={len(salida)}")

    if debug:
        # Diagnóstico: muestra los registros reales y por qué se aceptan o descartan
        muestra = []
        for e in items[:20]:
            crudo = e.get("timestamp")
            ts = a_ms(crudo)
            muestra.append({
                "ip": e.get("ip"),
                "timestamp_guardado": crudo,
                "tipo_dato": type(crudo).__name__,
                "edad_seg": round((ahora - ts) / 1000, 1),
                "resultado": "sin ip" if not e.get("ip")
                             else "descartado: más viejo que la ventana" if ts < desde
                             else "aceptado",
            })
        return responder(200, {
            "version": VERSION,
            "region": os.environ.get("AWS_REGION"),
            "tabla": tabla.name,
            "ventana_seg": VENTANA_SEG,
            "ahora_ms": ahora,
            "desde_ms": desde,
            "leidos_en_tabla": len(items),
            "devueltos": len(salida),
            "muestra": muestra,
        })
    return responder(200, salida)


# ---------------------------------------------------------------- entrada
def lambda_handler(event, context):
    metodo = (event.get("requestContext", {}).get("http", {}).get("method")
              or event.get("httpMethod") or "GET").upper()
    try:
        if metodo == "POST":
            return guardar(event)
        if metodo == "GET":
            q = event.get("queryStringParameters") or {}
            return listar(debug=q.get("debug") == "1", solo_redes=q.get("redes") == "1")
        return responder(405, {"ok": False, "error": "método no permitido"})
    except Exception as err:
        print("ERROR:", repr(err))          # aparece en CloudWatch Logs
        return responder(500, {"ok": False, "error": "error interno"})
