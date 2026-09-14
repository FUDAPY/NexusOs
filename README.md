# NexusOS · POS / ERP / CRM

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/MongoDB-8.x-47A248?logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Mongoose-8-880000?logo=mongoose&logoColor=white" alt="Mongoose" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/Socket.IO-4.8-010101?logo=socketdotio&logoColor=white" alt="Socket.IO" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Tailwind_CSS-3-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/Capacitor-7-119EFF?logo=capacitor&logoColor=white" alt="Capacitor" />
  <img src="https://img.shields.io/badge/Android-API_36-34A853?logo=android&logoColor=white" alt="Android" />
  <img src="https://img.shields.io/badge/Google_Play-AAB-414141?logo=googleplay&logoColor=white" alt="Google Play" />
  <img src="https://img.shields.io/badge/Railpack-0.15.4-6E4AFF?logo=railway&logoColor=white" alt="Railpack" />
  <img src="https://img.shields.io/badge/Dokploy-self--hosted-111827?logo=docker&logoColor=white" alt="Dokploy" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Tests-Vitest-6E9F18?logo=vitest&logoColor=white" alt="Vitest" />
  <img src="https://img.shields.io/badge/Lint-ESLint_9-4B32C3?logo=eslint&logoColor=white" alt="ESLint" />
  <img src="https://img.shields.io/badge/Typing-strict_%C2%B7_no--any-3178C6?logo=typescript&logoColor=white" alt="Strict typing" />
  <img src="https://img.shields.io/badge/ACID-transacciones_Mongo-4EA94B?logo=mongodb&logoColor=white" alt="Transacciones ACID" />
  <img src="https://img.shields.io/badge/version-1.0.0-blue?logo=semver&logoColor=white" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?logo=opensourceinitiative&logoColor=white" alt="License" />
  <img src="https://img.shields.io/badge/status-production--ready-brightgreen" alt="Status" />
</p>

## 1. Contexto del Proyecto

- **Objetivo:** NexusOS es la plataforma unificada de operación comercial: punto de venta táctil, back-office administrativo/financiero, CRM de clientes y monitor de producción, todo sobre una API propia multi-sucursal.
- **Tipo de Aplicación:** API REST transaccional (tiempo real por WebSockets) + SPA de dashboard oscuro y POS táctil, empaquetable como aplicación **Android publicable en Google Play**.

## 2. Stack Tecnológico Estricto

- Lenguaje: Node.js `>=22` con TypeScript `5.7` en modo `strict` (prohibido `any`).
- Framework principal: Express `4.21` (API REST) + Socket.IO `4.8` (namespace `/kds` para producción).
- Base de datos: MongoDB `8.x` en **replica set** con ODM **Mongoose 8**; Redis 7 (`ioredis`) para sesiones, caché y locks de stock.
- Frontend: HTML5 + Tailwind CSS + Font Awesome, servido como estático y empaquetado con **Capacitor** para Android.
- Despliegue y Build: Railpack `0.15.4` + Dokploy (Docker Compose para infraestructura); APK/AAB con **Android Studio**. Licencia MIT.

## 3. Estructura de Archivos

```text
.
├── docker-compose.yml        # Infraestructura: MongoDB (replica set) + Redis
├── frontend/                 # SPA: POS, dashboard, CRM, KDS, app de cliente
│   ├── pos.html              # Terminal de venta táctil
│   ├── dashboard.html        # Panel financiero / gerencial
│   ├── caja.html             # Arqueo y cierre de turno
│   ├── kds.html              # Monitor de cocina (tiempo real)
│   └── …                     # 24 rutas en total
├── mobile/                   # Proyecto Android (Capacitor)
│   ├── capacitor.config.json
│   └── android/              # Proyecto Gradle abrible en Android Studio
└── server/
    ├── src/
    │   ├── config/           # env (zod), conexión Mongo, cliente Redis
    │   ├── controllers/      # capa HTTP: parseo, status codes
    │   ├── services/         # reglas de negocio + transacciones ACID
    │   ├── models/           # esquemas Mongoose
    │   ├── schemas/          # validación de entrada con zod
    │   ├── routes/           # routers Express por módulo
    │   ├── middlewares/      # auth de servicio, caché, manejo de errores
    │   ├── sockets/          # namespace KDS (tiempo real)
    │   ├── utils/            # logger, respuesta estándar, withTransaction
    │   ├── app.ts            # composición de la app Express
    │   └── index.ts          # bootstrap HTTP + Socket.IO + graceful shutdown
    ├── scripts/              # herramientas operativas (ver §6)
    ├── tests/                # pruebas unitarias (Vitest)
    ├── railpack.json         # plan de build/deploy (Railpack 0.15.4)
    ├── tsconfig.json         # build: rootDir src → dist
    ├── tsconfig.check.json   # type-check de src + tests + scripts
    ├── .env.example          # variables de entorno (plantilla)
    └── package.json
```

### Colecciones MongoDB

| Colección | Responsabilidad |
| --- | --- |
| `users` | Personal, roles, PIN/RFID, estado y referencias de sucursal. |
| `branches` | Sucursales, tema visual, horarios, contacto y configuración local. |
| `products` | Catálogo, precios, costos, stock, recetas de producción y estado **Agotado**. |
| `categories` | Categorías del menú: orden, ícono y visibilidad en POS. |
| `currencies` | Tasas de cambio con PYG como moneda base (USD, ARS, BRL). |
| `orders` | Tickets de venta: totales, método de pago, estado y entrega. |
| `order_items` | Detalle por producto vinculado al ticket, con trazabilidad de stock. |
| `cash_shifts` | Turnos de caja: apertura, cierre, métricas por medio de pago. |
| `cash_closes` | Arqueos y cierres: declaración vs sistema, diferencias y sobrantes. |
| `audit_logs` | Registro **append-only** de transacciones críticas y tickets de soporte. |

**Herramientas de negocio:** inventario con kardex (`inventory_movements`), producción
(`production_batches`, `production_config`), CRM y beneficios (`lin_tickets`,
`lin_ticket_claims`, `credit_pins`), metas (`public_goals`), alertas
(`support_alerts`) y sincronización (`sync_logs`).

## 4. Reglas de Desarrollo Obligatorias

- Todo el código nuevo debe incluir pruebas unitarias.
- Tipado estricto en TS (sin `any`).
- Transacciones ACID en DB para lógicas críticas.
- Manejo de errores estándar `{ success: false, error: "msg" }`.

### Patrones obligatorios

- **Transacciones ACID:** toda operación que cruce colecciones (ej. crear ticket + descontar stock + `audit_logs`) se ejecuta dentro de `withTransaction()`. Requiere MongoDB en **replica set**; en un nodo standalone la función degrada y lo reporta en el log.
- **Anti-sobreventa:** el descuento de stock usa `findOneAndUpdate` con filtro `stock: { $gte: cantidad }` e `$inc: -cantidad`; si no afecta documentos, se lanza `409 INSUFFICIENT_STOCK`.
- **Concurrencia de caja:** un solo turno abierto por sucursal/caja, garantizado con índice único parcial (`partialFilterExpression: { estadoTurno: 'abierto' }`).
- **Auditoría inmutable:** `audit_logs` solo admite inserciones (hooks que bloquean `updateOne`, `findOneAndUpdate`, `deleteOne` y `deleteMany`) y aplica TTL de 5 años.
- **Contrato de respuesta:** éxito `{ success: true, data }`; error `{ success: false, error, code? }`, generado siempre desde `utils/response.ts`.

## 5. Convenciones de Código

- Comentarios breves y técnicos. Cero explicaciones redundantes.
- Prohibidas las firmas de IA o menciones sobre asistencia automatizada.
- Prefijo `I` para interfaces (`IOrder`), `PascalCase` para archivos de modelos y `kebab.case.ts` para servicios, rutas y controladores.
- Colecciones y campos en español para mantener la coherencia con el frontend (ej. `fecha`, `nombreCliente`, `metodoPago`).

## 6. Comandos de Verificación

- Instalar: `cd server; npm install`
- Correr tests: `npm run test`
- Linting: `npm run lint`
- Build: `railpack build;`
- Type-check: `npm run typecheck`
- Desarrollo: `npm run dev`
- Copiar datos entre instancias: `npm run mongo:copy` (requiere `MONGO_SOURCE_URI`)
- Replica set: `npm run mongo:replica:status` · `npm run mongo:replica:init`

### Despliegue en Dokploy

1. **Infraestructura** — servicio *Docker Compose* apuntando a este repositorio. Usa el
   `docker-compose.yml` de la raíz y levanta MongoDB (replica set de un nodo con keyFile propio)
   más Redis. Cargar en **Environment** las variables de `server/.env.database.example`.
2. **API** — servicio *Application* con builder **Railpack `0.15.4`** y **Build Path** `server/`.
   Cargar en **Environment** las variables de `server/.env.app.example`, apuntando a los hosts
   internos (`mongo:27017`, `redis:6379`).
3. Inicializar el replica set una sola vez: `npm run mongo:replica:init`.
4. Publicar el namespace de tiempo real en `/realtime`.

### Aplicación Android (APK / Google Play)

El proyecto nativo vive en `mobile/android` y empaqueta el frontend vía Capacitor
(`mobile/capacitor.config.json` → `webDir: ../frontend`).

1. Sincronizar el frontend con el proyecto nativo:
   ```
   cd mobile
   npx cap sync android
   ```
2. Abrir el proyecto en **Android Studio**:
   `File → Open… → mobile/android`
3. Generar el bundle firmado:
   `Build → Generate Signed Bundle / APK… → Android App Bundle`
   > Google Play exige **`.aab`** para publicaciones nuevas; el `.apk` sirve solo para pruebas locales.
4. Subir el `.aab` en **Play Console**. Antes de cada subida hay que incrementar `versionCode`
   en `mobile/android/app/build.gradle`.

| Parámetro | Valor actual |
| --- | --- |
| `applicationId` | `com.lingroup.clublin` |
| `versionCode` / `versionName` | `170` / `17.0` |
| `minSdkVersion` | 24 |
| `compileSdkVersion` / `targetSdkVersion` | 36 / 36 |

> ⚠️ **`applicationId` es permanente.** Google Play identifica la app por ese valor: si se cambia,
> la consola lo trata como una aplicación **nueva** y no se puede actualizar la existente.
> Mantener `com.lingroup.clublin` para seguir publicando sobre la ficha actual.

Requisitos de firma: keystore de release (fuera del repositorio) y **Play App Signing** activado
en Play Console.

### Variables de entorno

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `MONGO_URI` | sí | Debe incluir el nombre de la base antes del `?`. Encodea caracteres reservados de la clave (`@` → `%40`). |
| `MONGO_DB_NAME` | sí | Nombre de la base (por defecto `pos_cate`). |
| `REDIS_URL` | sí | Redis con `--requirepass`. |
| `JWT_SECRET` | sí | ≥ 32 caracteres. Generar con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `CORS_ORIGINS` | no | Dominios separados por coma; vacío = acepta cualquier origen. |
| `PORT` / `API_PREFIX` | no | `3000` / `/api/v1`. |

## Licencia

MIT License

Copyright (c) 2026 Dev Giuliano Catella

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
