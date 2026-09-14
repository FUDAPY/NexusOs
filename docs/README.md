# Roadmap · Migración de Firestore a la API propia (MongoDB en Dokploy)

> Documento vivo. Los números salen de medir el repo, no de estimaciones.

---

## Punto de partida (medido)

| Dato | Valor |
| --- | --- |
| Páginas HTML | **23** |
| Páginas que hablan con Firestore | **21** |
| Páginas estáticas (no requieren nada) | 2 (`condiciones.html`, `terminos.html`) |
| **Operaciones Firestore totales** | **280** |
| Colecciones en MongoDB (ya migradas) | **27** |
| Modelos Mongoose escritos | 10 |
| **Endpoints del API** | **4** (`/health`, `POST /orders`, `GET /orders`, `PATCH /orders/:id/cocina`, `GET /audit-logs`) |
| Archivos de rutas | 2 (`order.routes.ts`, `audit.routes.ts`) |

### Carga de trabajo por página

| Página | Líneas | Ops Firestore | Prioridad |
| --- | --- | --- | --- |
| `pos.html` | 4 094 | **54** | 🔴 crítica |
| `dashboard.html` | 3 189 | **53** | 🔴 crítica |
| `app_cliente.html` | 3 346 | **27** | 🟡 pública |
| `clientes.html` | 1 336 | 21 | 🟠 alta |
| `inventario.html` | 957 | 15 | 🟠 alta |
| `app_delivery.html` | 867 | 15 | 🟡 pública |
| `lin_tickets.html` | 510 | 11 | 🟢 media |
| `produccion.html` | 639 | 11 | 🟢 media |
| `caja.html` | 1 021 | 9 | 🟠 alta |
| `sucursales.html` | 539 | 9 | 🟢 media |
| `usuarios.html` | 464 | 9 | 🟠 alta |
| `relatorio_cierres.html` | 602 | 7 | 🟢 media |
| `reportes.html` | 1 450 | 6 | 🟢 media |
| `solicitud_premium.html` | 535 | 6 | 🟢 media |
| `auditoria_transacciones.html` | 525 | 4 | 🟢 media |
| `kds.html` | 524 | 4 | 🟠 alta (tiempo real) |
| `metas-publicas.html` | 1 153 | 4 | 🟢 media |
| `monitor_problemas.html` | 890 | 4 | 🟢 media |
| `notificaciones.html` | 350 | 4 | 🟢 media |
| `stock.html` | 799 | 4 | 🟢 media |
| `index.html` | 1 044 | 3 | 🔴 crítica (login) |

**Total: 280 operaciones.** El 38% está en solo 2 archivos (`pos` + `dashboard`).

### Operaciones a reemplazar

| Firestore | Equivalente en la API | Existe hoy |
| --- | --- | --- |
| `getDocs` / `getDoc` | `GET` | parcial |
| `onSnapshot` | Socket.IO (namespace `/kds`) o polling | ❌ |
| `setDoc` / `addDoc` | `POST` | parcial |
| `updateDoc` | `PATCH` | parcial |
| `deleteDoc` | `DELETE` | ❌ |
| `writeBatch` | endpoint transaccional por caso de uso | ❌ |
| `runTransaction` | `withTransaction()` del servidor | parcial |
| `serverTimestamp()` | `new Date()` en el servidor | n/a |
| `increment()` | `$inc` atómico | n/a |
| `query/where/orderBy/limit` | query params del `GET` | ❌ |
| `firebase.auth` | endpoint de login + JWT | ❌ |

---

## Reglas del roadmap

1. **Una página no se migra hasta que TODOS sus endpoints existan y estén probados.** Sin excepción.
2. **Por cada página migrada, leer y escribir se cambian juntos.** Nunca dejar una página leyendo del API y escribiendo en Firestore.
3. **Nada se borra de Firestore.** Firestore queda como respaldo hasta la Etapa 7.
4. **Cada etapa termina con el sistema funcionando**, no a mitad de camino.
5. `tests/` del servidor no puede bajar de 31 pruebas verdes. Cada endpoint nuevo suma las suyas.

---

## Etapa 0 · Desbloquear (horas)

**Objetivo:** que el cierre de caja deje de fallar. No es parte de la migración, pero bloquea la operación.

- [ ] `cashFlows` con `allow write: if false` bloquea `pos.html:2824`. Dos caminos:
  - **(a)** permitir escritura a `admin`/`cajero` y `firebase deploy --only firestore:rules`
  - **(b)** quitar ese `batch.set` del POS y registrar el cierre solo en `cierresCaja`
- [ ] Decidir (a) o (b) **antes** de tocar nada más.

**Criterio de cierre:** el botón "Cerrar Caja / Cierre Z" completa sin error y deja el registro en `cierresCaja`.

---

## Etapa 1 · Autenticación (la base de todo)

Sin esto, ninguna otra etapa avanza. Hoy `index.html` entra con `firebase.auth` y las reglas de Firestore deciden qué puede hacer cada rol.

- [ ] Endpoint `POST /api/v1/auth/login` (usuario/PIN o email+password) → devuelve JWT
- [ ] Middleware de autorización por rol (`admin`, `cajero`, `produccion`, `cliente`)
- [ ] `POST /api/v1/auth/refresh` y `POST /api/v1/auth/logout`
- [ ] `index.html` deja de usar `firebase.auth` y usa el API
- [ ] `nexus-api.js` ya manda el token: `NexusAPI.token = '<jwt>'` (está implementado)
- [ ] Los 5 roles que hoy valida `firestore.rules` pasan a validarse en el servidor

**Riesgo:** el hash de PIN y las contraseñas. `users` en Mongo ya tiene `passwordHash` (bcrypt) — hay que verificar que la migración lo trajo.

**Criterio de cierre:** se entra al sistema con el API, el token viaja en cada request, y una página sin token recibe 401.

---

## Etapa 2 · Endpoints de lectura (catálogo completo)

**Esta etapa NO toca el frontend.** Solo agrega endpoints y pruebas. Al terminarla el sistema sigue funcionando igual que hoy — cero riesgo para la operación.

- [ ] `GET /api/v1/products` (con `branchId`, `estado`, `visibilidad`, `q`, `limit`, `offset`)
- [ ] `GET /api/v1/branches`
- [ ] `GET /api/v1/users` (sin exponer `passwordHash`)
- [ ] `GET /api/v1/currencies`
- [ ] `GET /api/v1/categories`
- [ ] `GET /api/v1/cash-shifts` (turnos)
- [ ] `GET /api/v1/cash-closes` (cierres)
- [ ] `GET /api/v1/inventory-movements`
- [ ] `GET /api/v1/lin-tickets` y `GET /api/v1/lin-ticket-claims`
- [ ] Paginación y filtros unificados: `?limit=&offset=&sort=&order=`
- [ ] Contrato de respuesta: `{ success, data }` / `{ success, error, code }` (ya existe en `utils/response.ts`)
- [ ] Pruebas para cada endpoint (subir de 31 a ~60)

**Criterio de cierre:** los 10 endpoints responden datos reales, con pruebas verdes, y **ninguna página cambió todavía**.

---

## Etapa 3 · Tiempo real (reemplazo de `onSnapshot`)

Firestore notifica cambios solos. La API no. Hay 3 casos que dependen de eso:

| Página | Qué necesita en vivo |
| --- | --- |
| `kds.html` | Pedidos nuevos y cambios de estado |
| `inventario.html` | Stock que baja cuando el POS vende |
| `pos.html` | Aviso de cambios de stock en otro dispositivo |

- [ ] Extender el namespace `/kds` (ya existe en `sockets/kds.ts`, path `/realtime`) con salas por sucursal
- [ ] Emitir eventos al confirmar venta, cerrar caja y ajustar stock
- [ ] `nexus-api.js`: agregar `NexusAPI.realtime.on(evento, cb)` con reconexión automática
- [ ] Plan B donde el tiempo real no sea crítico: *refetch* al recuperar foco (`visibilitychange`)

**Criterio de cierre:** abrir `kds.html` en un dispositivo y vender en el POS de otro → el pedido aparece sin recargar.

---

## Etapa 4 · Migración página por página

**Orden por dependencias, no por tamaño.** Cada página es un bloque cerrado: endpoint + lectura + escritura + prueba manual.

### Bloque A — Núcleo de operación
| # | Página | Ops | Depende de |
| --- | --- | --- | --- |
| 1 | `index.html` | 3 | Etapa 1 |
| 2 | `usuarios.html` | 9 | Etapa 2 |
| 3 | `sucursales.html` | 9 | Etapa 2 |
| 4 | `inventario.html` | 15 | Etapas 2 y 3 |
| 5 | `stock.html` | 4 | Etapa 2 |

### Bloque B — El POS (el más riesgoso)
| # | Página | Ops | Depende de |
| --- | --- | --- | --- |
| 6 | `pos.html` | **54** | Bloque A + endpoints de venta transaccional |
| 7 | `caja.html` | 9 | `pos.html` |
| 8 | `kds.html` | 4 | Etapa 3 |

> `pos.html` concentra la venta, el stock, los descuentos VIP, los BOGO, la producción y el cierre Z.
> **Es el último de su bloque a propósito**: todo lo demás tiene que estar estable antes de tocarlo.

### Bloque C — Administración y reportes
| # | Página | Ops |
| --- | --- | --- |
| 9 | `dashboard.html` | **53** |
| 10 | `reportes.html` | 6 |
| 11 | `relatorio_cierres.html` | 7 |
| 12 | `auditoria_transacciones.html` | 4 |
| 13 | `monitor_problemas.html` | 4 |
| 14 | `notificaciones.html` | 4 |
| 15 | `produccion.html` | 11 |

### Bloque D — CRM y programas
| # | Página | Ops |
| --- | --- | --- |
| 16 | `clientes.html` | 21 |
| 17 | `lin_tickets.html` | 11 |
| 18 | `metas-publicas.html` | 4 |
| 19 | `solicitud_premium.html` | 6 |

### Bloque E — Públicas
| # | Página | Ops |
| --- | --- | --- |
| 20 | `app_cliente.html` | 27 |
| 21 | `app_delivery.html` | 15 |

**Criterio de cierre de cada página:** se usa en producción durante una jornada completa, sin tocar Firestore, y el dato coincide entre la página y `mongosh`.

---

## Etapa 5 · APK y Android

- [ ] `npx cap sync android` con las páginas ya migradas
- [ ] `applicationId` definitivo **antes** del primer envío a Play (es permanente)
- [ ] `versionCode` incremental en cada subida
- [ ] Keystore de release fuera del repo + huellas SHA-1/SHA-256 registradas
- [ ] Verificar que el APK apunte al dominio propio (`NEXUS_API_BASE`)

---

## Etapa 6 · Apagar Firestore

**Solo cuando las 21 páginas estén migradas y verificadas.**

- [ ] Una jornada completa de operación real sin una sola llamada a `firestore.googleapis.com`
- [ ] Confirmar en DevTools → Network: **0 requests** a `firestore.googleapis.com` y `firebaseio.com`
- [ ] Respaldo completo de Firestore exportado a un archivo
- [ ] Recién ahí: despublicar el proyecto de Firebase y rotar las claves públicas

---

## Riesgos y cómo se mitigan

| Riesgo | Mitigación |
| --- | --- |
| **Migrar `pos.html` y romper la venta** | Es lo último del Bloque B. Endpoints transaccionales probados antes de tocarlo. |
| **Perder el tiempo real y que el KDS no se entere de pedidos** | Etapa 3 antes del Bloque B. Plan B con refetch al recuperar foco. |
| **Datos que no coinciden entre Firestore y Mongo** | Etapa 2 solo lee. Comparar `GET /products` contra Firestore producto por producto antes de escribir nada. |
| **Las reglas de Firestore bloquean algo más** | **Ya pasó con `cashFlows`.** Auditoría hecha: de 33 colecciones con `match`, **4 están bloqueadas para escritura**: `cashFlows`, `cashFlowContributions`, `cashFlowAudits`, `systemAlerts`. Cualquier página que escriba en ellas va a fallar con `Missing or insufficient permissions`. |
| **Doble escritura silenciosa** | Regla 2: lectura y escritura se cambian juntas en la misma página. |
| **El rol de usuario se pierde al migrar auth** | Los 5 roles de `firestore.rules` tienen que existir en el JWT. Probarlo antes del Bloque B. |

---

## Lo que NO se debe hacer

1. **No migrar las 21 páginas de una vez.** Se rompe la operación y no se sabe qué falló.
2. **No borrar Firestore antes de la Etapa 6.** Es el único respaldo real que hay hoy.
3. **No dejar una página leyendo del API y escribiendo en Firestore.** El dato se desincroniza y no se nota hasta que alguien cuadra la caja.
4. **No tocar `pos.html` antes que `inventario.html` y el stock.** El POS es el que cobra.
5. **No migrar sin pruebas.** Los 31 tests actuales son el piso: cada endpoint nuevo suma los suyos.

---

## Orden de arranque recomendado

```
Etapa 0  → desbloquear el cierre de caja        (horas)
Etapa 1  → autenticación                        (1 bloque)
Etapa 2  → endpoints de lectura, sin tocar UI   (2-3 bloques)
Etapa 3  → tiempo real                          (1 bloque)
Bloque A → index, usuarios, sucursales, inventario, stock
Bloque B → pos, caja, kds                       ← el crítico
Bloques C, D, E
Etapa 5  → APK
Etapa 6  → apagar Firestore
```

---

## Estado actual

| Etapa | Estado |
| --- | --- |
| Backend (Mongo + replica set + Redis) | ✅ operativo |
| API desplegada en Dokploy con dominio | ✅ operativo |
| Etapa 0 | ⏳ **bloqueada**: falta decidir (a) o (b) en `cashFlows` |
| Etapas 1 a 6 | ⏳ sin empezar |
| APK | ⏳ sin empezar |
