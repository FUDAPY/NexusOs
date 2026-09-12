# POS CATE · POS / ERP / CRM

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/MongoDB-8.x-47A248?logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Mongoose-ODM-880000?logo=mongoose&logoColor=white" alt="Mongoose" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white" alt="Socket.IO" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/Railpack-0.15.4-6E4AFF?logo=railway&logoColor=white" alt="Railpack" />
  <img src="https://img.shields.io/badge/Dokploy-self--hosted-111827?logo=docker&logoColor=white" alt="Dokploy" />
  <img src="https://img.shields.io/badge/Docker-multi--stage-2496ED?logo=docker&logoColor=white" alt="Docker" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Tests-Vitest-6E9F18?logo=vitest&logoColor=white" alt="Vitest" />
  <img src="https://img.shields.io/badge/Lint-ESLint_9-4B32C3?logo=eslint&logoColor=white" alt="ESLint" />
  <img src="https://img.shields.io/badge/Typing-strict_%C2%B7_no--any-3178C6?logo=typescript&logoColor=white" alt="Strict typing" />
  <img src="https://img.shields.io/badge/ACID-transacciones_Mongo-4EA94B?logo=mongodb&logoColor=white" alt="Transacciones ACID" />
  <img src="https://img.shields.io/badge/version-1.0.0-blue?logo=semver&logoColor=white" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?logo=opensourceinitiative&logoColor=white" alt="License" />
  <img src="https://img.shields.io/badge/status-migraci%C3%B3n%20Firebase%20%E2%86%92%20MongoDB-orange?logo=firebase&logoColor=white" alt="Status" />
</p>

## 1. Contexto del Proyecto

- **Objetivo:** Reconstruir POS CATE como monolito modular propio (POS · ERP · CRM · KDS) migrando de Firebase Firestore a MongoDB con paridad 1:1 de colecciones, sobre VPS con Dokploy y Railpack.
- **Tipo de Aplicación:** API REST multi-sucursal (transaccional, con caché Redis y tiempo real por WebSockets) + SPA de dashboard oscuro y POS táctil.

## 2. Stack Tecnológico Estricto

- Lenguaje: Node.js `>=22` con TypeScript `5.7` en modo `strict` (prohibido `any`).
- Framework principal: Express `4.21` (API REST) + Socket.IO `4.8` (namespace `/kds`).
- Base de datos: MongoDB `8.x` con ODM **Mongoose 8**; Redis 7 (`ioredis`) para sesiones, caché y locks de stock.
- Despliegue y Build: Railpack `0.15.4` + Dokploy sobre VPS; licencia MIT.

## 3. Estructura de Archivos

```text
server/
  ├── src/
  │   ├── config/          # env (zod), conexión Mongo, cliente Redis
  │   ├── controllers/     # capa HTTP: parseo, status codes
  │   ├── services/        # reglas de negocio + transacciones ACID
  │   ├── models/          # esquemas Mongoose (paridad 1:1 con Firestore)
  │   ├── schemas/         # validación de entrada con zod
  │   ├── routes/          # routers Express por módulo
  │   ├── middlewares/     # auth de servicio, caché, manejo de errores
  │   ├── sockets/         # namespace KDS (tiempo real)
  │   ├── utils/           # logger, respuesta estándar, withTransaction
  │   ├── app.ts           # composición de la app Express
  │   └── index.ts         # bootstrap HTTP + Socket.IO + graceful shutdown
  ├── scripts/             # migrate-firestore.ts (ETL Firestore → MongoDB)
  ├── tests/               # pruebas unitarias (Vitest)
  ├── railpack.json        # plan de build/deploy (Railpack 0.15.4)
  ├── vitest.config.ts
  ├── eslint.config.js
  ├── tsconfig.json        # build (rootDir src → dist)
  ├── tsconfig.check.json  # type-check de src + tests + scripts
  ├── .env.example
  └── package.json
```

### Colecciones (paridad estricta con Firestore)

| Colección MongoDB | Origen Firestore | Documentos | Responsabilidad |
| --- | --- | --- | --- |
| `users` | `users` | 65 | Roles, RFID, deuda/credito, puntos, benefícios. |
| `branches` | `branches` | 2 | Sucursales: tema, horarios, RUC, contacto. |
| `products` | `products` | 286 | Catálogo, precios, stock, recetas de producción. |
| `orders` | `artifacts/erp_lingroup/users/admin_master_001/sales` | **15 298** | Tickets de venta (campo `ticket_id`). |
| `order_items` | *derivado de* `orders.items` | — | Detalle por producto + vínculo `orderId`. |
| `cash_shifts` | `cashFlows` | 140 | Turnos de caja con totales planos. |
| `cash_closes` | `cierresCaja` | 316 | Arqueos/cierres: declaración vs sistema. |
| `audit_logs` | `auditoria` + `systemAlerts` | 217 + 353 | Append-only: transacciones críticas + tickets de soporte. |
| `currencies` | *derivado de* `settings/sistema.divisas` | — | PYG base + USD/ARS/BRL. |
| `categories` | *derivado de* `products.categoria` | — | Categorías del menú para el POS. |

Colecciones adicionales migradas sin cambios de nombre de campo: `cash_flow_audits` (481),
`cash_flow_contributions` (89), `inventory_movements` (2 201), `sync_logs` (12 709),
`support_alerts` (353), `production_batches` (12), `production_config` (3), `public_goals` (3),
`lin_tickets`, `lin_ticket_claims`, `credit_pins`, `credit_pin_attempts`, `password_reset_otps`,
`password_reset_rate_limits`, `play_tester_requests`, `notifications`, `settings`.

### Migración ejecutada (Firestore → MongoDB)

Corrida real verificada: **27 colecciones / 57 805 documentos**.

```bash
cd server
npm run migrate:dry                                  # simulacro, no escribe
npm run migrate:firestore                            # migración completa
npm run migrate:firestore -- --only=orders,settings   # reanudar colecciones puntuales
npm run migrate:derive                               # regenerar derivados (items/currencies/categories)
```

| Destino | Documentos |
| --- | --- |
| `orders` | 15 322 |
| `order_items` | 25 495 |
| `sync_logs` | 12 710 |
| `inventory_movements` | 2 202 |
| `cash_flow_audits` / `cash_flow_contributions` | 485 / 115 |
| `support_alerts` | 353 |
| `cash_closes` | 316 |
| `products` | 286 |
| `audit_logs` | 218 |
| `cash_shifts` | 140 |
| `users` | 65 |
| `currencies` / `categories` | 4 / 6 |
| resto | 754 |

Notas de la migración:

- **Los tickets no eran una colección raíz.** Viven en la ruta privada `artifacts/erp_lingroup/users/admin_master_001/sales`. Cualquier migración que solo recorra colecciones raíz los pierde.
- `_id` se preserva cuando el ID de Firestore es un `ObjectId` válido; si no (IDs de 20 caracteres como `003Jljv7OSqMjmpcAvgm`), se genera un `ObjectId` y el original queda en `legacyId`.
- `Timestamp` (`{ _seconds, _nanoseconds }`) → `Date`; `GeoPoint` → GeoJSON; `DocumentReference` → path.
- `cierresCaja` embebe el HTML del reporte Z. Requiere `batchSize: 20`; con 500 la consulta de Firestore devuelve `DEADLINE_EXCEEDED`.
- `currencies` y `categories` son **derivadas**: `settings/sistema.divisas` (`PYG` base, USD 5 800, ARS 3, BRL 1 000) y los valores distintos de `products.categoria`.

### Variables de entorno (Dokploy)

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `MONGO_URI` | sí | Debe incluir nombre de BD y la contraseña URL-encoded (`@` → `%40`). |
| `MONGO_DB_NAME` | sí | Base destino de la migración (por defecto `pos_cate`). |
| `REDIS_URL` | sí | **Pendiente de provisionar en Dokploy.** |
| `JWT_SECRET` | sí | ≥ 32 caracteres; generar con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `CORS_ORIGINS` | no | Lista separada por comas; vacío = cualquier origen. |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | solo ETL | Ruta al JSON del service account. |
| `FIREBASE_SALES_PATH` | solo ETL | Ruta privada `artifacts/**` con los tickets. |

> **Bloqueante de infraestructura:** el MongoDB provisionado es **standalone** (`directConnection=true`, sin `setName`).
> `withTransaction()` detecta esto y degrada a ejecución sin transacción: `crear orden + descontar stock` **no es atómico**.
> Para producción hay que reconstruir Mongo como replica set de un nodo (`--replSet rs0` + `rs.initiate()`) y usar
> `mongodb://…/pos_cate?authSource=admin&replicaSet=rs0`.


## 4. Reglas de Desarrollo Obligatorias

- Todo el código nuevo debe incluir pruebas unitarias.
- Tipado estricto en TS (sin `any`).
- Transacciones ACID en DB para lógicas críticas.
- Manejo de errores estándar `{ success: false, error: "msg" }`.

### Patrones obligatorios

- **Transacciones ACID:** toda operación que cruce colecciones (ej. crear ticket + descontar stock + `audit_logs`) se ejecuta dentro de `withTransaction()`. Requiere MongoDB con replica set (Dokploy lo despliega así).
- **Anti-sobreventa:** el descuento de stock usa `findOneAndUpdate` con filtro `stock: { $gte: cantidad }` e `$inc: -cantidad`; si la actualización no afecta documentos, se lanza `409 INSUFFICIENT_STOCK`.
- **Concurrencia de caja:** un turno abierto por sucursal/caja se garantiza con índice único parcial (`partialFilterExpression: { estadoTurno: 'abierto' }`).
- **Auditoría inmutable:** `audit_logs` solo admite inserciones (hooks que bloquean `updateOne`/`findOneAndUpdate`/`deleteOne`/`deleteMany`) y tiene TTL de 5 años.
- **Contrato de respuesta:** éxito `{ success: true, data }`; error `{ success: false, error, code? }`, generado siempre desde `utils/response.ts`.

## 5. Convenciones de Código

- Comentarios breves y técnicos. Cero explicaciones redundantes.
- Prohibidas las firmas de IA o menciones sobre asistencia automatizada.
- Prefijo `IPascal` para interfaces, nombres de archivo en `PascalCase` para modelos y `kebab.case.ts` para servicios/rutas/controladores.
- Colecciones y campos en español para mantener la paridad con el frontend y con Firestore (ej. `fecha`, `nombreCliente`, `metodoPago`).

## 6. Comandos de Verificación

- Instalar: `cd server; npm install`
- Correr tests: `npm run test`
- Linting: `npm run lint`
- Build: `railpack build;`
- Type-check: `npm run typecheck`
- Desarrollo: `npm run dev`
- Migrar datos: `npm run migrate:firestore`

### Despliegue en Dokploy

1. Crear el servicio desde el repositorio y fijar **Build Path** en `server/`.
2. Seleccionar el builder **Railpack `0.15.4`** (lee `server/railpack.json`: `npm run build` → `node dist/index.js`).
3. Provisionar MongoDB con replica set y Redis en el mismo entorno; cargar las variables de `.env.example`.
4. Exponer el puerto `PORT` y publicar el namespace de tiempo real en `/realtime`.

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

© 2026 Giuliano Emanuel Maria Catella Riveros (Otelax Dev). Licencia MIT: se permite usar, copiar, modificar y distribuir mencionando al creador. Ver LICENSE.

