# Libro de Facturas — Proyecto completo

App Android (PWA instalable) + servidor con suscripciones, construida siguiendo el orden de fases del plan de arquitectura.

## Lo que está construido

| Fase | Estado |
|---|---|
| **1 — Que funcione para uno**: login por teléfono, registro de facturas (foto y manual), historial, comparaciones | ✅ Completa |
| **2 — Que funcione para varios**: cuentas separadas, límites por plan, panel para registrar pagos | ✅ Completa |
| **3 — Que cobre solo**: estados de cuenta por fecha, gracia y suspensión, endpoint de pagos | ✅ Lógica lista. Falta conectar pasarela y avisos automáticos |
| **4 — Que crezca**: multi-usuario, exportación, alertas de precio | ⬜ Pendiente |

## Por qué no se puede piratear

El principio del plan se cumple en el código:

- **Los datos nunca están en el teléfono.** El historial, el catálogo y las comparaciones viven en SQLite del lado del servidor. Una copia de la app sin cuenta activa no muestra ni calcula nada.
- **El cálculo del precio por unidad ocurre en el servidor** (`POST /api/facturas`), no en el cliente. Ni la lógica viaja al dispositivo.
- **El OCR con IA corre en el servidor** con la clave de API protegida. Sin cuenta activa y sin cupo, no se procesa — y es la función que cuesta dinero real.
- **Una sesión activa por cuenta.** Entrar desde otro dispositivo invalida la sesión anterior (verificado en pruebas).
- **Toda consulta filtra por la cuenta del token.** El `cuenta_id` nunca se acepta desde el cliente.

## Estructura

```
proyecto/
├── server/
│   ├── server.js        API: auth, facturas, comparaciones, admin
│   ├── db.js            Esquema SQLite + semilla del catálogo
│   ├── catalogo.js      17 proveedores con su regla de columna + 91 presentaciones
│   └── .env.example
└── app/
    ├── index.html       La app completa (PWA, sin dependencias externas)
    ├── manifest.json    Para que Android la instale como app
    ├── sw.js            Funciona sin conexión (menos las llamadas a la API)
    └── icon-192.png / icon-512.png
```

El catálogo de proveedores es **global**: cada cuenta nueva lo hereda completo. Las presentaciones que confirma cada cliente se guardan en su propia cuenta.

## Cómo correrlo

```bash
cd server
npm install
cp .env.example .env      # edita ANTHROPIC_API_KEY y ADMIN_TOKEN
npm start
```

Abre `http://localhost:3000`. En modo desarrollo el código de acceso se muestra en pantalla y en la consola, así que puedes entrar sin proveedor de mensajería.

Sin `ANTHROPIC_API_KEY` todo funciona menos el registro por foto.

## Convertirlo en APK

1. **Sube el servidor a un hosting con HTTPS** (Railway, Render, Fly.io, o un VPS con Caddy). HTTPS es obligatorio: sin él, Android no instala PWAs ni da acceso a la cámara.
2. Verifica que `https://tudominio.com` cargue la app.
3. Entra a **pwabuilder.com**, pega la URL, y descarga el paquete Android (`.apk` / `.aab`).
4. Instala el `.apk` en el teléfono (hay que permitir "orígenes desconocidos" la primera vez).

Para publicar en Google Play necesitarás el `.aab` firmado y una cuenta de desarrollador.

## Antes de cobrarle a alguien

**Mide el costo real por factura procesada.** Procesa 20 facturas tuyas, mira lo que gastaste en la API, y divide. Ese número decide si los límites de cada plan tienen sentido. Los precios en `catalogo.js` son marcadores de posición, no una recomendación.

**Conecta la pasarela de pago.** Hoy los pagos se registran a mano desde el panel admin:

```bash
curl -X POST https://tudominio.com/api/admin/pago \
  -H "x-admin-token: TU_TOKEN" -H "content-type: application/json" \
  -d '{"cuenta_id":1,"plan_id":"basico","monto":495,"metodo":"transferencia","meses":1}'
```

Esto ya sirve para operar con transferencia y efectivo, que es como paga buena parte de este mercado. La pasarela (Azul/CardNet) automatiza el resto llamando a ese mismo endpoint.

**Envía los códigos de verdad.** Hoy el código OTP se imprime en consola. En producción, reemplaza ese `console.log` en `/api/auth/solicitar` por una llamada a WhatsApp Business API o SMS.

**Cambia `ADMIN_TOKEN`.** El valor por defecto (`admin-dev`) es para desarrollo.

## Qué falta para producción

- Envío real de OTP por WhatsApp/SMS
- Pasarela de pago conectada
- Avisos automáticos de vencimiento (3 días antes, el día, y al suspender)
- Guardar las imágenes de facturas (hoy solo se guardan los datos extraídos)
- Respaldos de la base de datos
- Migrar de SQLite a Postgres cuando superes unos cientos de clientes

## Notas técnicas

- **SQLite** es deliberado: una instancia aguanta cientos de clientes sin administrar base de datos. El esquema es compatible con Postgres cuando toque migrar.
- **Sin framework en el frontend.** Un solo HTML sin dependencias externas: carga rápido en conexiones lentas y funciona sin conexión.
- El service worker **nunca cachea `/api/`** — los datos siempre vienen frescos del servidor.
