# Sistema embebido GPS + Celular + AWS

Celular (Flutter, GPS) -> HTTPS -> API Gateway -> Lambda (Python) -> DynamoDB -> Dashboard (Leaflet)

## 1. AWS: base de datos (región us-east-1)
```bash
aws dynamodb create-table --table-name Devices \
  --attribute-definitions AttributeName=device_id,AttributeType=S \
  --key-schema AttributeName=device_id,KeyType=HASH --billing-mode PAY_PER_REQUEST

aws dynamodb create-table --table-name Locations \
  --attribute-definitions AttributeName=device_id,AttributeType=S AttributeName=timestamp,AttributeType=S \
  --key-schema AttributeName=device_id,KeyType=HASH AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

## 2. AWS: Lambda
1. Consola Lambda -> Crear función `gps-api`, runtime Python 3.12.
2. Pegar `lambda/lambda_function.py` y pulsar Deploy.
3. En el rol de ejecución, agregar permisos DynamoDB (PutItem, UpdateItem, Query, Scan) limitados a las 2 tablas (mínimo privilegio).

## 3. AWS: API Gateway (REST API)
1. Crear REST API `gps-api` con los recursos:
   - `/location` -> POST
   - `/devices` -> GET
   - `/locations/{device_id}` -> GET
   Todos con **integración proxy Lambda** hacia `gps-api`.
2. En cada método activar **API Key Required**.
3. En cada recurso usar **Enable CORS** (crea el método OPTIONS).
4. Deploy API -> stage `prod`.
5. Crear **Usage Plan** + **API Key**, asociarlos al stage `prod`.
6. Copiar la URL (`https://xxxx.execute-api.us-east-1.amazonaws.com/prod`) y la API Key.

## 4. Dashboard
Editar `API_URL` y `API_KEY` al inicio del script de `dashboard/index.html` y abrirlo en el navegador (o subirlo a S3 / GitHub Pages).

## 5. App Flutter
```bash
flutter create gps_tracker
# copiar flutter-app/pubspec.yaml y flutter-app/lib/* dentro de gps_tracker/
# pegar los permisos de flutter-app/android-config/AndroidManifest-permisos.xml
# editar lib/config.dart con la URL y la API Key
flutter pub get
flutter run                 # prueba en celular conectado por USB
flutter build apk --release # genera build/app/outputs/flutter-apk/app-release.apk
```
Para varios celulares: instalar el mismo APK en cada uno; cada instalación genera su propio `device_id`.

> Nota de seguridad: una API Key dentro del APK o del HTML no es secreta. Para el curso es suficiente; en producción usar Amazon Cognito o claves por dispositivo.

## Mapa en la app y tiempo real
- La app muestra un mapa con SOLO el recorrido del propio celular: gris = recorrido anterior (desde AWS), verde = sesión actual (directo del GPS, sin latencia de red).
- Intervalo de envío: `kIntervaloSegundos` en `flutter-app/lib/config.dart` (3 s). Refresco del dashboard: `REFRESH_MS` (2000 ms).

## Versión 2 (app + web rediseñadas)
- **Lambda:** vuelve a pegar `lambda/lambda_function.py` y pulsa Deploy (ahora el historial va en orden cronológico, con `from`, `to`, `step` y paginación).
- **App Flutter:** archivos `pubspec.yaml`, `lib/main.dart`, `lib/config.dart`, `lib/api.dart`, `lib/ui.dart`, `lib/pages/live_page.dart`, `lib/pages/history_page.dart`. Ejecuta `flutter pub get`.
- **Web:** `dashboard/index.html` con tu API URL y API Key.
- Envío cada 1 s (`kIntervaloSegundos`) y la web consulta cada 1 s. Si usas Usage Plan en API Gateway, súbelo a Rate 50 / Burst 100.
