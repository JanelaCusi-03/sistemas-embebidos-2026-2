/*
  Escáner de equipos en la red  —  ESP32  ->  AWS Lambda  ->  DynamoDB  ->  index.html

  Qué hace cada ciclo (cada ~20 s):
   1. Pregunta por ARP a todas las IP de la red (x.x.x.1 a x.x.x.254).
      Quien responde está conectado: así se obtiene su IP y su MAC.
   2. Mientras tanto "escucha" el WiFi (modo promiscuo) y anota el RSSI de cada MAC.
      Con ese RSSI la Lambda calcula la distancia (modelo log-distance).
   3. A los equipos nuevos les busca el nombre:
        - primero se lo pregunta al router (DNS inverso: el router conoce el nombre
          que cada equipo dio al conectarse, p. ej. "Infinix-X6873")
        - si el router no sabe, se lo pregunta al equipo por NetBIOS (PC con Windows).
   4. Escanea las redes WiFi cercanas (SSID, BSSID, canal, RSSI), como el informe.
   5. Envía todo en un solo POST a la Lambda:  {"equipos":[...], "redes":[...]}

  Placa: la que tengas -> "ESP32C3 Dev Module" (ESP32-C3) o "ESP32 Dev Module"
  En ESP32-C3: Herramientas -> "USB CDC On Boot: Enabled" para ver el Monitor Serie
  No necesita librerías extra.
*/
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "esp_wifi.h"
#include "esp_system.h"
#include "lwip/etharp.h"
#include "lwip/netif.h"
#include "lwip/tcpip.h"

// ------------------------------------------------------------ CONFIGURA AQUÍ
const char* WIFI_SSID  = "NOMBRE_DE_TU_WIFI";
const char* WIFI_PASS  = "CLAVE_DE_TU_WIFI";
const char* LAMBDA_URL = "https://XXXXXXXX.lambda-url.us-east-2.on.aws/";
const char* TOKEN      = "";      // igual a la variable TOKEN de la Lambda ("" si no la usas)

const uint32_t CICLO_MS       = 20000;  // cada cuánto se envía (menor a los 40 s del index)
const int      LOTE           = 8;      // IPs por lote (la tabla ARP del ESP32 es pequeña)
const int      ESPERA_LOTE_MS = 400;    // tiempo para que respondan (los celulares dormidos tardan)
const uint32_t RSSI_VALIDO_MS = 60000;  // un RSSI más viejo que esto ya no se usa
const int      MAX_REDES      = 40;     // máximo de redes WiFi cercanas por envío
// ---------------------------------------------------------------------------

// Datos por cada IP de la red (índice = último número de la IP)
struct Host {
  uint8_t mac[6];
  char    nombre[32];
  bool    nombreProbado; // ya se le buscó el nombre
  bool    esPc;          // respondió por NetBIOS (Windows)
  bool    visto;       // respondió en este ciclo
};
Host hosts[256];

// RSSI por MAC (lo llena el sniffer)
struct Senal { uint8_t mac[6]; int rssi; uint32_t t; bool usado; };
#define MAX_SEN 64
Senal sen[MAX_SEN];
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

WiFiUDP udp;
void conectarWiFi();   // se define más abajo
uint32_t ultimoEnvio = 0;

// ============================================================ SNIFFER (RSSI)
void sniffer(void* buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_DATA && type != WIFI_PKT_MGMT) return;
  const wifi_promiscuous_pkt_t* p = (wifi_promiscuous_pkt_t*)buf;
  if (p->rx_ctrl.sig_len < 24) return;
  const uint8_t* m = p->payload + 10;     // dirección 2 = quien envió el paquete
  if (m[0] & 0x01) return;                // ignora multicast / broadcast
  int rssi = p->rx_ctrl.rssi;
  uint32_t ahora = millis();

  portENTER_CRITICAL(&mux);
  int libre = -1, viejo = 0;
  for (int i = 0; i < MAX_SEN; i++) {
    if (sen[i].usado && memcmp(sen[i].mac, m, 6) == 0) {
      sen[i].rssi = (7 * sen[i].rssi + 3 * rssi) / 10;   // suavizado
      sen[i].t = ahora;
      portEXIT_CRITICAL(&mux);
      return;
    }
    if (!sen[i].usado && libre < 0) libre = i;
    if (sen[i].t < sen[viejo].t) viejo = i;
  }
  int k = (libre >= 0) ? libre : viejo;   // si está lleno, reemplaza el más viejo
  memcpy(sen[k].mac, m, 6);
  sen[k].rssi = rssi; sen[k].t = ahora; sen[k].usado = true;
  portEXIT_CRITICAL(&mux);
}

bool rssiDe(const uint8_t* mac, int& out) {
  bool ok = false;
  uint32_t ahora = millis();
  portENTER_CRITICAL(&mux);
  for (int i = 0; i < MAX_SEN; i++) {
    if (sen[i].usado && memcmp(sen[i].mac, mac, 6) == 0 && ahora - sen[i].t < RSSI_VALIDO_MS) {
      out = sen[i].rssi; ok = true; break;
    }
  }
  portEXIT_CRITICAL(&mux);
  return ok;
}

// ============================================================ ARP (IP + MAC)
void barrerRed() {
  IPAddress yo = WiFi.localIP();
  for (int h = 0; h < 256; h++) hosts[h].visto = false;

  for (int ini = 1; ini <= 254; ini += LOTE) {
    int fin = min(ini + LOTE - 1, 254);
    struct netif* nif = netif_default;
    if (!nif) return;

    // 1) Preguntar "¿quién tiene esta IP?"
    LOCK_TCPIP_CORE();
    for (int h = ini; h <= fin; h++) {
      if (h == yo[3]) continue;
      ip4_addr_t a; IP4_ADDR(&a, yo[0], yo[1], yo[2], h);
      etharp_request(nif, &a);
    }
    UNLOCK_TCPIP_CORE();

    delay(ESPERA_LOTE_MS);

    // 2) Leer quién respondió
    LOCK_TCPIP_CORE();
    for (int h = ini; h <= fin; h++) {
      if (h == yo[3]) continue;
      ip4_addr_t a; IP4_ADDR(&a, yo[0], yo[1], yo[2], h);
      struct eth_addr* mac = nullptr;
      const ip4_addr_t* ipr = nullptr;
      if (etharp_find_addr(nif, &a, &mac, &ipr) >= 0 && mac) {
        if (memcmp(hosts[h].mac, mac->addr, 6) != 0) {   // equipo nuevo en esa IP
          memcpy(hosts[h].mac, mac->addr, 6);
          hosts[h].nombre[0] = 0;
          hosts[h].nombreProbado = false;
          hosts[h].esPc = false;
        }
        hosts[h].visto = true;
      }
    }
    UNLOCK_TCPIP_CORE();
  }
}

// ============================================================ DNS inverso (nombre desde el router)
// servidor/puerto: el router (53) o el mismo equipo por mDNS (5353, responden iPhone/Mac)
bool nombreDns(IPAddress ip, IPAddress router, uint16_t puerto, char* destino, size_t tam) {
  destino[0] = 0;

  // Pregunta: "¿qué nombre tiene D.C.B.A.in-addr.arpa?" (tipo PTR)
  uint8_t q[64];
  const uint8_t cab[] = {0xBE, 0xEF, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0};
  memcpy(q, cab, sizeof(cab));
  int n = sizeof(cab);
  for (int i = 3; i >= 0; i--) {
    char num[4];
    int L = snprintf(num, sizeof(num), "%d", ip[i]);
    q[n++] = L; memcpy(q + n, num, L); n += L;
  }
  const char* sufijo[] = {"in-addr", "arpa"};
  for (const char* sfx : sufijo) {
    int L = strlen(sfx);
    q[n++] = L; memcpy(q + n, sfx, L); n += L;
  }
  q[n++] = 0;
  q[n++] = 0; q[n++] = 12;   // tipo PTR
  q[n++] = 0; q[n++] = 1;    // clase IN

  while (udp.parsePacket() > 0) { while (udp.available()) udp.read(); }
  udp.beginPacket(router, puerto);
  udp.write(q, n);
  udp.endPacket();

  uint32_t t0 = millis();
  while (millis() - t0 < 300) {
    if (udp.parsePacket() > 0) {
      uint8_t r[512];
      int len = udp.read(r, sizeof(r));
      if (udp.remoteIP() != router || len < 12 || r[0] != 0xBE || r[1] != 0xEF) continue;
      int respuestas = (r[6] << 8) | r[7];
      if (respuestas == 0 || (r[3] & 0x0F) != 0) return false;   // el router no lo conoce

      int p = 12;
      int preguntas = (r[4] << 8) | r[5];
      if (preguntas > 0) {                          // saltar la pregunta
        while (p < len && r[p] != 0 && (r[p] & 0xC0) != 0xC0) p += r[p] + 1;
        p += (p < len && (r[p] & 0xC0) == 0xC0) ? 2 : 1;
        p += 4;
      }
      if (p < len && (r[p] & 0xC0) == 0xC0) p += 2;  // nombre de la respuesta
      else { while (p < len && r[p] != 0) p += r[p] + 1; p += 1; }
      if (p + 10 > len) return false;
      int tipo = (r[p] << 8) | r[p + 1];
      p += 10;                                      // tipo, clase, ttl, longitud
      if (tipo != 12 || p >= len) return false;

      int L = r[p];                                 // primera parte: "Infinix-X6873" de "Infinix-X6873.lan"
      if (L == 0 || (L & 0xC0) || p + 1 + L > len) return false;
      size_t k = 0;
      bool tieneLetra = false;
      for (int i = 0; i < L && k < tam - 1; i++) {
        char c = (char)r[p + 1 + i];
        if (isalnum((unsigned char)c) || c == '-' || c == '_') {
          destino[k++] = c;
          if (isalpha((unsigned char)c)) tieneLetra = true;
        }
      }
      destino[k] = 0;
      if (!tieneLetra) destino[0] = 0;              // nombres tipo "192-168-1-5" no sirven
      return destino[0] != 0;
    }
    delay(5);
  }
  return false;
}

// ============================================================ NetBIOS (nombre)
void nombreNetbios(IPAddress ip, char* destino, size_t tam) {
  destino[0] = 0;
  const uint8_t cab[] = {0xA5, 0x5A, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x20, 'C', 'K'};
  const uint8_t fin[] = {0, 0, 0x21, 0, 1};
  while (udp.parsePacket() > 0) { while (udp.available()) udp.read(); }   // descarta respuestas viejas
  udp.beginPacket(ip, 137);
  udp.write(cab, sizeof(cab));
  for (int i = 0; i < 30; i++) udp.write('A');
  udp.write(fin, sizeof(fin));
  udp.endPacket();

  uint32_t t0 = millis();
  while (millis() - t0 < 250) {
    if (udp.parsePacket() > 0) {
      uint8_t r[300];
      int n = udp.read(r, sizeof(r));
      if (udp.remoteIP() != ip) continue;
      if (n >= 72 && r[56] > 0) {               // 56 = cantidad de nombres
        size_t k = 0;
        for (int i = 0; i < 15 && k < tam - 1; i++) {
          char c = (char)r[57 + i];
          if (c == ' ' || c == 0) break;
          if (isalnum((unsigned char)c) || c == '-' || c == '_') destino[k++] = c;
        }
        destino[k] = 0;
      }
      return;
    }
    delay(5);
  }
}

// ============================================================ ENVÍO A AWS
// Texto seguro dentro de JSON (comillas, barras y caracteres de control)
String escJson(const String& s) {
  String o;
  o.reserve(s.length() + 4);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((uint8_t)c < 32) o += ' ';
    else o += c;
  }
  return o;
}

String macTexto(const uint8_t* m) {
  char b[18];
  snprintf(b, sizeof(b), "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
  return String(b);
}

void agregar(String& json, bool& primero, IPAddress ip, const uint8_t* mac,
             const char* nombre, const char* tipo, bool hayRssi, int rssi, int canal) {
  json += primero ? "{" : ",{";
  primero = false;
  json += "\"ip\":\"" + ip.toString() + "\"";
  json += ",\"mac\":\"" + macTexto(mac) + "\"";
  if (nombre && nombre[0]) json += ",\"nombre\":\"" + escJson(String(nombre)) + "\"";
  if (tipo && tipo[0])     json += ",\"tipo\":\"" + String(tipo) + "\"";
  if (hayRssi)             json += ",\"rssi\":" + String(rssi);
  if (canal > 0)           json += ",\"canal\":" + String(canal);
  json += "}";
}

void enviar(const String& json) {
  WiFiClientSecure cliente;
  cliente.setInsecure();               // no verifica el certificado (suficiente para el curso)
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(cliente, LAMBDA_URL)) { Serial.println("No pude abrir la URL"); return; }
  http.addHeader("Content-Type", "application/json");
  if (strlen(TOKEN)) http.addHeader("x-token", TOKEN);
  int codigo = http.POST(json);
  Serial.printf("POST -> %d  %s\n", codigo, http.getString().c_str());
  http.end();
}

// ============================================================ REDES WiFi CERCANAS
const char* seguridad(wifi_auth_mode_t m) {
  switch (m) {
    case WIFI_AUTH_OPEN:         return "Abierta";
    case WIFI_AUTH_WEP:          return "WEP";
    case WIFI_AUTH_WPA_PSK:      return "WPA";
    case WIFI_AUTH_WPA2_PSK:     return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
    case WIFI_AUTH_WPA3_PSK:     return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK:return "WPA2/WPA3";
    default:                     return "Otra";
  }
}

String escanearRedes() {
  esp_wifi_set_promiscuous(false);           // pausa el sniffer mientras escanea
  int n = WiFi.scanNetworks(false, true);    // true = incluye redes ocultas
  delay(100);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("  (el escaneo cortó el WiFi, reconectando...)");
    conectarWiFi();
  }
  esp_wifi_set_promiscuous(true);

  String j = "[";
  int enviadas = 0;
  for (int i = 0; i < n && enviadas < MAX_REDES; i++) {
    if (enviadas) j += ",";
    j += "{\"ssid\":\"" + escJson(WiFi.SSID(i)) + "\"";
    j += ",\"bssid\":\"" + WiFi.BSSIDstr(i) + "\"";
    j += ",\"canal\":" + String(WiFi.channel(i));
    j += ",\"rssi\":" + String(WiFi.RSSI(i));
    j += ",\"seguridad\":\"" + String(seguridad(WiFi.encryptionType(i))) + "\"}";
    enviadas++;
  }
  j += "]";
  WiFi.scanDelete();
  Serial.printf("Redes WiFi cercanas: %d\n", n < 0 ? 0 : n);
  return j;
}

// ============================================================ CICLO
uint32_t numCiclo = 0;
char ssidRed[33];

void cicloCompleto() {
  // Cada 15 ciclos (~5 min) se vuelve a buscar el nombre de los que no tienen
  if (++numCiclo % 15 == 0)
    for (int h = 0; h < 256; h++) if (!hosts[h].nombre[0]) hosts[h].nombreProbado = false;

  // Nombre de la red (SSID) sin comillas ni barras, para usarlo como nombre del router
  String ss = WiFi.SSID();
  size_t k = 0;
  for (size_t i = 0; i < ss.length() && k < sizeof(ssidRed) - 1; i++)
    if (ss[i] != '"' && ss[i] != '\\' && (uint8_t)ss[i] >= 32) ssidRed[k++] = ss[i];
  ssidRed[k] = 0;

  Serial.println("1/4 Escaneando redes WiFi cercanas...");
  String redes = escanearRedes();
  Serial.println("2/4 Buscando equipos en la red (unos 15 s)...");
  barrerRed();
  Serial.println("3/4 Buscando nombres...");

  IPAddress yo = WiFi.localIP();
  IPAddress gw = WiFi.gatewayIP();
  String json = "{\"equipos\":[";
  bool primero = true;
  int cuantos = 0;

  // El propio ESP32
  uint8_t miMac[6];
  WiFi.macAddress(miMac);
  agregar(json, primero, yo, miMac, "ESP32-Escaner", "IoT", false, 0, WiFi.channel());
  cuantos++;

  for (int h = 1; h <= 254; h++) {
    if (!hosts[h].visto) continue;
    IPAddress ip(yo[0], yo[1], yo[2], h);
    bool esRouter = (ip == gw);

    if (!esRouter && !hosts[h].nombreProbado) {      // solo una vez por equipo
      char* nom = hosts[h].nombre;
      size_t tam = sizeof(hosts[h].nombre);
      if (!nombreDns(ip, gw, 53, nom, tam) &&        // 1) el router
          !nombreDns(ip, ip, 5353, nom, tam)) {      // 2) el equipo por mDNS (Apple)
        nombreNetbios(ip, nom, tam);                 // 3) el equipo por NetBIOS (Windows)
        hosts[h].esPc = nom[0] != 0;
      }
      hosts[h].nombreProbado = true;
    }

    int rssi = 0;
    bool hayRssi = rssiDe(hosts[h].mac, rssi);
    if (esRouter) { rssi = WiFi.RSSI(); hayRssi = true; }   // señal hacia el router

    const char* tipo = esRouter ? "Router" : (hosts[h].esPc ? "Laptop" : "");
    const char* nombre = esRouter ? ssidRed : hosts[h].nombre;
    // Canal: el de tu red, solo si el ESP32 escuchó al equipo en ese canal
    agregar(json, primero, ip, hosts[h].mac, nombre, tipo, hayRssi, rssi, hayRssi ? WiFi.channel() : 0);
    cuantos++;
  }
  json += "],\"redes\":" + redes + "}";

  Serial.printf("4/4 Equipos encontrados: %d. Enviando a AWS...\n", cuantos);
  Serial.println(json);
  enviar(json);
}

// ============================================================ SETUP / LOOP
void conectarWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                // necesario para escuchar bien el canal
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  // Las placas ESP32-C3 pequeñas fallan con la potencia al máximo (se caen o se reinician)
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
  Serial.print("Conectando a WiFi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
    if (millis() - t0 > 20000) { Serial.println("\nNo conecta, reiniciando..."); ESP.restart(); }
  }
  Serial.printf("\nConectado. IP: %s  Canal: %d\n", WiFi.localIP().toString().c_str(), WiFi.channel());
}

const char* motivoReinicio() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "encendido normal";
    case ESP_RST_SW:       return "reinicio por software";
    case ESP_RST_PANIC:    return "ERROR: el programa se cayó (crash)";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "ERROR: se colgó (watchdog)";
    case ESP_RST_BROWNOUT: return "ERROR: falta de energía (brownout)";
    default:               return "otro";
  }
}

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);   // espera el USB del ESP32-C3
  delay(300);
  Serial.printf("\n=== Escáner iniciado. Motivo del arranque: %s ===\n", motivoReinicio());
  memset(hosts, 0, sizeof(hosts));
  memset(sen, 0, sizeof(sen));

  conectarWiFi();
  udp.begin(13700);

  // Modo promiscuo en el mismo canal del router (sin desconectarse)
  wifi_promiscuous_filter_t filtro = {
    .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA
  };
  esp_wifi_set_promiscuous_filter(&filtro);
  esp_wifi_set_promiscuous_rx_cb(&sniffer);
  esp_wifi_set_promiscuous(true);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    esp_wifi_set_promiscuous(false);
    conectarWiFi();
    esp_wifi_set_promiscuous(true);
  }
  if (millis() - ultimoEnvio >= CICLO_MS || ultimoEnvio == 0) {
    ultimoEnvio = millis();
    cicloCompleto();
  }
  delay(50);
}
