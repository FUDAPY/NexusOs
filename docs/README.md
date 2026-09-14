# Roadmap · Migración de Firestore a MongoDB (Dokploy Compose)

> **Principio rector:** preparar TODAS las bases primero. La migración de datos va **al final**, cuando ya no se esté vendiendo. Hasta ese momento el sistema sigue operando sobre Firestore sin interrupciones.

---

## Cómo leer este documento

| Color | Significado |
| --- | --- |
| 🔵 **PREPARAR** | Se hace ahora. **No toca la operación.** El POS sigue vendiendo igual. |
| 🟡 **ENSAYAR** | Se prueba en paralelo, con el interruptor apagado. |
| 🔴 **CORTAR** | Se ejecuta en la ventana sin ventas (de noche). |

Las fases 1 a 7 son 🔵/🟡 y **se pueden hacer todas sin que nadie deje de vender**.
Las fases 8 a 10 son 🔴 y requieren la ventana de mantenimiento.

---

## Inventario de partida (medido del repo)

| Dato | Valor |
| --- | --- |
| Páginas HTML | 23 |
| Páginas conectadas a Firestore | **21** |
| Operaciones Firestore a reemplazar | **280** |
| Colecciones con `match` en `firestore.rules` | **33** |
| Colecciones bloqueadas para escritura | **4** (`cashFlows`, `cashFlowContributions`, `cashFlowAudits`, `systemAlerts`) |
| Colecciones en MongoDB | **27** |
| Documentos migrados | 57 845 (15 332 pedidos) |
| Modelos Mongoose escritos | 10 |
| **Endpoints del API** | **4** |

### Carga por página

| Página | Líneas | Ops | Bloque |
| --- | --- | --- | --- |
| `pos.html` | 4 094 | **54** | B |
| `dashboard.html` | 3 189 | **53** | C |
| `app_cliente.html` | 3 346 | 27 | E |
| `clientes.html` | 1 336 | 21 | D |
| `inventario.html` | 957 | 15 | A |
| `app_delivery.html` | 867 | 15 | E |
| `lin_tickets.html` | 510 | 11 | D |
| `produccion.html` | 639 | 11 | C |
| `caja.html` | 1 021 | 9 | B |
| `sucursales.html` | 539 | 9 | A |
| `usuarios.html` | 464 | 9 | A |
| `relatorio_cierres.html` | 602 | 7 | C |
| `reportes.html` | 1 450 | 6 | C |
| `solicitud_premium.html` | 535 | 6 | D |
| `auditoria_transacciones.html` | 525 | 4 | C |
| `kds.html` | 524 | 4 | B |
| `metas-publicas.html` | 1 153 | 4 | D |
| `monitor_problemas.html` | 890 | 4 | C |
| `notificaciones.html` | 350 | 4 | C |
| `stock.html` | 799 | 4 | A |
| `index.html` | 1 044 | 3 | A |

---

## La estrategia: interruptor de doble vía

Esta es la decisión de arquitectura que hace que la migración sea **reversible**.

En vez de reescribir las 21 páginas (lo que rompería ~20 por falta de endpoints), se construye una **capa de adaptación** que expone la misma interfaz que las páginas ya usan hoy —`getDocs`, `setDoc`, `onSnapshot`…— pero por dentro pega contra la API.

```text
HOY:     pos.html ──► firebase/firestore ────────────► Firestore
AHORA:   pos.html ──► nexus-data.js ──► NexusAPI ──► API ──► MongoDB
                          ▲
                     interruptor
```

### Por qué esto cambia el riesgo

| Ventaja | Efecto |
| --- | --- |
| Las páginas **no se reescriben** | `pos.html` (4 094 líneas) cambia ~1 línea en vez de 54 bloques |
| El interruptor es **por página** | Si una falla, se vuelve atrás sin tocar las demás |
| Se puede tener **las dos fuentes vivas** | Firestore sigue intacto como respaldo |
| El corte es **inmediato y reversible** | Volver atrás = cambiar una bandera |

```js
// El interruptor. Un valor por página: 'firestore' | 'api'
localStorage.setItem('nexus.fuente.pos', 'api');
```

**Nada de esto se activa hasta la Fase 8.** Hasta entonces las páginas siguen en `firestore`.

---

## FASE 1 · Auditoría de paridad 🔵

**Objetivo:** saber exactamente qué hay de cada lado, antes de escribir una línea de código.

**No modifica nada. Solo lee y reporta.**

- [ ] Script `npm run paridad` que recorra:
  - cada colección de Firestore (33) con su cantidad de documentos
  - cada colección de MongoDB (27) con su cantidad de documentos
  - el resultado: tabla de coincidencias y diferencias
- [ ] Para las colecciones que coinciden: comparar la **forma de un documento** (qué campos tiene cada lado)
- [ ] Reporte de **campos que faltan** de un lado o del otro
- [ ] Reporte de **colecciones sin par** (solo Firestore o solo Mongo)
- [ ] Guardar el reporte como `docs/paridad.json` para consulta

**Entregable:** tabla con 33 filas que dice, colección por colección, si está lista o no.

**Criterio de cierre:** está claro qué colecciones ya se pueden servir desde Mongo y cuáles necesitan trabajo de datos.

---

## FASE 2 · Completar los modelos Mongoose 🔵

**Objetivo:** que MongoDB tenga un modelo por cada colección que el frontend necesita. Hoy hay 10 y hacen falta ~27.

- [ ] Un archivo por colección en `server/src/models/`
- [ ] Cada modelo con sus **índices** (sucursal, fecha, estado, ticket_id) para que los filtros del frontend no hagan *collection scan*
- [ ] Corrección de tipos: `Boolean` donde hoy llega `1` o `"true"` (ver la nota de stock al final)
- [ ] **Sin `strict: false`**: si un campo de Firestore no está en el esquema, hay que agregarlo explícitamente, no ignorarlo
- [ ] Pruebas de esquema por modelo

**Entregable:** `mongosh` muestra las 27 colecciones con sus índices.

**Criterio de cierre:** `GET /products` (Fase 3) devuelve los mismos campos que Firestore, producto por producto.

---

## FASE 3 · API completa — los endpoints 🔵

**Objetivo:** que existan **todos** los endpoints que las 21 páginas necesitan. Esta fase **no toca el frontend**, así que el riesgo para la operación es **cero**.

### 3.1 Lectura (por colección)

| Método | Ruta | Para qué página |
| --- | --- | --- |
| `GET` | `/api/v1/products` | pos, inventario, stock, dashboard |
| `GET` | `/api/v1/branches` | sucursales, pos, todas |
| `GET` | `/api/v1/users` | usuarios, pos, dashboard |
| `GET` | `/api/v1/categories` | pos, inventario |
| `GET` | `/api/v1/currencies` | pos, caja |
| `GET` | `/api/v1/cash-shifts` | caja, relatorio_cierres |
| `GET` | `/api/v1/cash-closes` | relatorio_cierres, dashboard |
| `GET` | `/api/v1/inventory-movements` | inventario, auditoria |
| `GET` | `/api/v1/lin-tickets` | lin_tickets, clientes |
| `GET` | `/api/v1/lin-ticket-claims` | lin_tickets |
| `GET` | `/api/v1/public-goals` | metas-publicas |
| `GET` | `/api/v1/production-batches` | produccion |
| `GET` | `/api/v1/support-alerts` | monitor_problemas |
| `GET` | `/api/v1/sync-logs` | monitor_problemas |
| `GET` | `/api/v1/notifications` | notificaciones |

### 3.2 Filtros unificados

Todas las rutas de lectura aceptan los mismos parámetros, para que la capa de adaptación traduzca `query(where(), orderBy(), limit())` sin casos especiales:

```
?sucursal=&estado=&desde=&hasta=&q=&limit=&offset=&sort=&order=
```

### 3.3 Escritura

| Método | Ruta | Nota |
| --- | --- | --- |
| `POST` | `/api/v1/products` · `PATCH /products/:id` | inventario |
| `POST` | `/api/v1/users` · `PATCH /users/:id` | usuarios |
| `POST` | `/api/v1/orders` | ✅ ya existe |
| `PATCH` | `/api/v1/orders/:id/cocina` | ✅ ya existe |
| `POST` | `/api/v1/orders/:id/anular` | anulación con reversión de stock |
| `POST` | `/api/v1/cash-shifts/abrir` · `/cerrar` | caja |
| `POST` | `/api/v1/inventory/adjust` | inventario |

### 3.4 Transaccionales (reemplazan `writeBatch` y `runTransaction`)

Cada uno dentro de `withTransaction()` y con `audit_logs`:

- [ ] `POST /orders/confirmar` — venta + descuento de stock + movimientos + auditoría, todo o nada
- [ ] `POST /orders/:id/anular` — anulación parcial o total + devolución de stock
- [ ] `POST /cash-shifts/cerrar` — cierre Z + `cash_shifts` + `cash_closes` + auditoría

**Entregable:** los ~35 endpoints con pruebas. Los tests suben de 31 a ~70.

**Criterio de cierre:** se puede vender, anular y cerrar caja **solo con curl**, sin tocar el frontend.

---

## FASE 4 · Capa de adaptación en el frontend 🔵 **← la fase clave**

**Objetivo:** que cada página pueda cambiar de fuente sin reescribirse.

- [ ] Crear `frontend/nexus-data.js` que exponga **la misma interfaz** que ya usan las páginas:
  - `getDocs(query(...))` → `GET`
  - `getDoc(doc(db, col, id))` → `GET /:id`
  - `setDoc` / `updateDoc` / `addDoc` → `POST` / `PATCH`
  - `deleteDoc` → `DELETE`
  - `serverTimestamp()` → marca local, el servidor pone la fecha real
  - `increment(n)` → instrucción `$inc`
- [ ] Traductor de `where()` / `orderBy()` / `limit()` → query params
- [ ] Interruptor por página: `nexus.fuente.<pagina>` = `firestore` \| `api`
- [ ] Modo **sombra**: con la fuente en `firestore`, además pega al API y **compara** los resultados, sin usarlos. Registra diferencias.
- [ ] `NexusAPI` ya existe y maneja token, reintentos, caché y deduplicación

**El modo sombra es la pieza más valiosa de todo el plan**: permite saber si el API devuelve lo mismo que Firestore **mientras el POS sigue vendiendo con Firestore**. Si hay diferencias, se ven en el log antes del corte.

**Criterio de cierre:** con el interruptor en `api`, una página de prueba funciona igual que con `firestore`.

---

## FASE 5 · Autenticación 🔵

Hoy entra `firebase.auth` y `firestore.rules` decide los permisos. Los roles son `admin`, `cajero`, `produccion` y cliente.

- [ ] `POST /api/v1/auth/login` (usuario/PIN o email+password) → JWT
- [ ] Middleware de rol reemplazando lo que hoy hace `firestore.rules`
- [ ] Verificar que la migración trajo `passwordHash` de cada usuario de `users`
- [ ] `index.html` con el interruptor: `firebase.auth` ↔ `POST /auth/login`
- [ ] `NexusAPI.token` ya está implementado en `nexus-api.js`

**Criterio de cierre:** se entra al sistema con el API y una ruta sin token devuelve 401.

---

## FASE 6 · Tiempo real (reemplazo de `onSnapshot`) 🔵

Firestore avisa solo. La API no. Sin esto, `kds.html` no se entera de los pedidos nuevos.

| Página | Qué necesita en vivo |
| --- | --- |
| `kds.html` | Pedidos nuevos y cambios de estado |
| `inventario.html` | Stock que baja cuando el POS vende |
| `pos.html` | Aviso de stock cambiado en otro dispositivo |

- [ ] Extender el namespace `/kds` (ya existe en `sockets/kds.ts`, path `/realtime`) con salas por sucursal
- [ ] Emitir eventos al confirmar venta, anular y ajustar stock
- [ ] `nexus-data.js`: `onSnapshot` → suscripción al socket, con la misma firma
- [ ] **Plan B**: refetch al recuperar el foco (`visibilitychange`) + cada 30 s donde no sea crítico

**Criterio de cierre:** vender en un dispositivo y ver el pedido aparecer en el KDS de otro sin recargar.

---

## FASE 7 · Ensayo general (dry-run) 🟡

**Objetivo:** ejecutar la migración completa **sin apagar nada**, sobre una copia.

- [ ] Restaurar un respaldo de Mongo en una base de pruebas (`pos_cate_dry`)
- [ ] Correr el importador de Firestore → Mongo contra esa base
- [ ] Comparar **documento por documento**: `count` por colección y muestreo de campos
- [ ] Poner el interruptor en `api` apuntando a `pos_cate_dry` y recorrer las 21 páginas
- [ ] Anotar cada diferencia en `docs/paridad.json`
- [ ] Ensayar el **rollback**: volver el interruptor a `firestore` y confirmar que todo sigue andando

**Criterio de cierre:** el ensayo corre de punta a punta sin sorpresas y el rollback está probado.

---

## FASE 8 · Migración de datos 🔴 **AL FINAL, con las ventas cerradas**

> Solo se ejecuta cuando ya no se esté vendiendo.

- [ ] Aviso al personal y **cierre de caja** del turno
- [ ] Respaldo completo de Firestore a un archivo
- [ ] Respaldo completo de Mongo (`mongodump`)
- [ ] Congelar escrituras: páginas en **solo lectura** (o cerrar el acceso)
- [ ] Ejecutar el importador Firestore → Mongo definitivo
- [ ] Verificar conteos contra los respaldos
- [ ] **Punto de decisión:** si algo no cuadra, se restaura el respaldo y se vuelve a Firestore

**Criterio de cierre:** las 27 colecciones en Mongo con los mismos documentos que Firestore y los campos clave presentes.

---

## FASE 9 · Corte y verificación 🔴

- [ ] Poner el interruptor de las 21 páginas en `api`
- [ ] Recorrer cada página verificando contra `mongosh`:
  - venta de prueba → stock baja → aparece en `inventory_movements`
  - apertura y cierre de caja
  - KDS en tiempo real
  - login con cada rol
- [ ] **Un turno completo de venta real** con el interruptor en `api`
- [ ] Dejar el rollback a mano durante 48 h

**Criterio de cierre:** una jornada completa operando sobre Mongo, sin una sola escritura perdida.

---

## FASE 10 · Apagar Firestore 🔴

- [ ] Revisar DevTools → Network: **0 requests** a `firestore.googleapis.com`
- [ ] Exportar Firestore una última vez y guardar el archivo fuera del servidor
- [ ] Recién ahí: despublicar el proyecto de Firebase y rotar las claves públicas
- [ ] Quitar `firebase` de las 21 páginas y del APK

---

## Checklist "listo para la noche del corte"

Todo esto tiene que estar ✅ **antes** de empezar la Fase 8:

- [ ] Fase 1: `docs/paridad.json` sin diferencias pendientes
- [ ] Fase 2: 27 modelos con índices
- [ ] Fase 3: ~35 endpoints y ~70 pruebas verdes
- [ ] Fase 4: interruptor funcionando y modo sombra sin diferencias
- [ ] Fase 5: login con JWT por rol
- [ ] Fase 6: KDS en tiempo real
- [ ] Fase 7: ensayo completo + rollback probado
- [ ] Respaldo de Firestore **y** de Mongo descargados
- [ ] Quien hace el corte tiene este documento a mano

**Si algo de esta lista falta, la migración se posterga.** Ninguna urgencia justifica arriesgar una jornada de ventas.

---

## Riesgos y mitigación

| Riesgo | Mitigación |
| --- | --- |
| Romper la venta al migrar `pos.html` | Es el **último** de su bloque y el interruptor es reversible por página |
| El KDS no se entera de pedidos | Fase 6 antes del corte; plan B con polling |
| 4 colecciones bloqueadas por reglas | `cashFlows`, `cashFlowContributions`, `cashFlowAudits`, `systemAlerts` son `allow write: if false` |
| Campos con tipo distinto entre Firestore y Mongo | `controlado` puede llegar como `1` o `"true"`. La Fase 1 lo detecta; el POS ya se blindó con `esControlado()` |
| Datos que no coinciden y nadie lo nota | **Modo sombra** (Fase 4) compara en vivo durante días antes del corte |
| El corte se va de las manos | Rollback por interruptor, probado en la Fase 7 |

---

## Reglas de trabajo

1. **No se migra una página hasta que TODOS sus endpoints existan y estén probados.**
2. **Lectura y escritura se cambian juntas** en la misma página.
3. **Firestore no se borra** hasta la Fase 10.
4. **Cada fase termina con el sistema vendiendo.** Ninguna queda a mitad de camino.
5. **Los 31 tests actuales son el piso.** Cada endpoint nuevo suma los suyos.

---

## Estado actual

| Fase | Estado |
| --- | --- |
| Backend (Mongo + replica set + Redis) | ✅ operativo |
| API desplegada en Dokploy con dominio | ✅ operativo |
| Colecciones migradas (57 845 docs) | ✅ hecho |
| **Fase 1** · Auditoría de paridad | ⏳ sin empezar |
| Fases 2 a 10 | ⏳ sin empezar |

> **Pendiente de decisión:** el cierre de caja falla por la regla `cashFlows: allow write: if false`. Hay que elegir entre abrir la regla a `cajero` o quitar esa escritura del POS. Conviene resolverlo antes de arrancar.
