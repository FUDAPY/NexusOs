# Roadmap NexusOS · de Firestore a MongoDB/Dokploy

Leyenda: ✅ hecho y verificado · ⏳ pendiente · 🔴 bloqueante

---

## Estado actual

### Backend (Dokploy)

| Pieza | Estado |
|---|---|
| MongoDB replica set (ACID activo) | ✅ |
| 27 colecciones migradas (57 845 docs) | ✅ |
| 23 modelos Mongoose | ✅ |
| ~55 endpoints de lectura (`resource.factory`) | ✅ |
| `POST /orders` (venta) | ✅ |
| `POST /orders/:id/anular` (total **y parcial**) | ✅ |
| `POST /orders/:id/cobro` (aprobar/rechazar abono) | ✅ |
| `POST /orders/:id/abonar` (excluir del arqueo) | ✅ |
| `POST /cash-shifts/cerrar` (cierre Z del cajero) | ✅ |
| `POST /cash-shifts/forzar-cierre` (cierre de sucursal) | ✅ |
| `PATCH /config/sistema` (tasas, limites, descuentos) | ✅ |
| `POST /auth/login` · `/registro` · `/perfil` · `/password` | ✅ |
| 5 eventos Socket.IO (namespace `/kds`, path `/realtime`) | ✅ |
| **Control de acceso JWT en toda la API** | ✅ |
| Rate limiting (login 10/5min, registro 5/15min) | ✅ |

### Frontend

| Pieza | Estado |
|---|---|
| `nexus-api.js` (cliente HTTP) | ✅ |
| `nexus-data.js` (adaptador + interruptor por pagina) | ✅ |
| `nexus-realtime.js` (Socket.IO + `resync`) | ✅ |
| `nexus-auth.js` (sesion + login) | ✅ |
| `index.html` sin `firebase.auth` ni Firestore | ✅ |
| `dashboard.html` | ⏳ |
| Otras 18 paginas con Firestore | ⏳ |

### Pruebas

`tsc --noEmit` = 0 · `tsc -p tsconfig.check.json` = 0 · todas en verde.

`tests/`: `response` · `models` · `mongoId` · `acceso` (31) · `cashFlow` (**el
calculo de dinero del arqueo**).

---

## 🔴 Bloqueantes actuales

**Ninguno.** Los dos que habia (`/config/sistema` y `/cash-shifts/forzar-cierre`)
estan resueltos.

---

## 🟡 1. Migrar `dashboard.html` — en curso

Es la pagina que queda en Firestore y la unica con tiempo real de verdad.

**Hecho (commit `023dc31`):** los `<script>` de `nexus-data.js` y `nexus-realtime.js`,
y las **9 lecturas** de la tabla 1.1, cada una con sus dos ramas segun
`NexusData.esMongo('dashboard')`. Ambas ramas devuelven la MISMA forma
(`{ id, ...datos }`) para que el codigo de abajo no se duplique. Los 5 listeners
(config, cierres de turno, resumen de flujo, ventas y auditoria) usan una funcion
local con el cuerpo compartido: las dos fuentes se comportan igual **por
construccion**, no por disciplina de mantener dos copias sincronizadas.

**Falta:** `iniciarEscuchaVentasTurno` (el del bootstrap), `cargarVentasTurnoUnaVez`,
`cargarSucursalesRelatorioCierres`, las **10 escrituras** de 1.2 y `cerrarSesion`.

Verificado con `node --check` sobre el modulo extraido del HTML (178 531 caracteres).
El interruptor sigue en `firestore`: **nada cambio en produccion** todavia.

### 1.1 Lecturas — reemplazar por `NexusData`

| Metodo | Linea | Origen | Destino |
|---|---|---|---|
| `cargarConfiguracionSistema` | 1448 | `onSnapshot config` | `vigilar('settings')` |
| `iniciarEscuchaEnVivo` | 1502 | `onSnapshot cierresCaja` | `vigilar('cierresCaja')` |
| `iniciarEscuchaResumenTurno` | 1527 | `onSnapshot cashFlows` | `vigilar('cashFlows')` |
| `iniciarEscuchaVentasTurno` | 1548 | `onSnapshot sales` | `vigilar('sales')` |
| `cargarVentasTurnoUnaVez` | 1590 | `getDocs sales` | `leer('sales')` |
| `iniciarEscuchaAuditoria` | 1658 | `onSnapshot auditoria` | `vigilar('auditoria')` |
| `cargarMetricasEstaticas` | 1688 | `getCountFromServer` | `contar('products')` / `contar('users')` |
| `cargarSucursalesDisponibles` | 957 | `getDocs branches` | `leer('branches')` |
| `cargarSucursalesRelatorioCierres` | 1723 | `getDocs branches` | `leer('branches')` |
| `cargarRelatorioCierres` | 1745 | `getDocs cierresCaja` | `leer('cierresCaja')` |
| `obtenerSucursalesParaForzarCierre` | 2152 | `getDocs branches` | `leer('branches')` |
| `obtenerContextoCierreForzado` | 2184 | `getDocs cierresCaja + cashFlows` | `leer(...)` |

### 1.2 Escrituras — usar los endpoints nuevos

| Metodo | Linea | Antes | Ahora |
|---|---|---|---|
| `aprobarCobroCliente` | 2738 | `writeBatch` (users + sales) | `POST /orders/:id/cobro {accion:'aprobar'}` |
| `rechazarCobroCliente` | 2771 | `updateDoc sales` | `POST /orders/:id/cobro {accion:'rechazar'}` |
| `marcarTicketComoAbonado` | 2695 | `updateDoc` + `setDoc auditoria` | `POST /orders/:id/abonar {motivo}` |
| `ejecutarAnulacionTotal` | 2944 | `writeBatch` | `POST /orders/:id/anular {tipo:'total'}` |
| `restarProductoTicket` | 2795 | `writeBatch` | `POST /orders/:id/anular {tipo:'parcial', cantidades}` |
| `actualizarTasaCambio` | 3071 | `setDoc config/sistema` | `PATCH /config/sistema {divisas:{USD:n}}` |
| `actualizarLimiteCredito` | 3106 | `setDoc config/sistema` | `PATCH /config/sistema` |
| `actualizarDescuentoEfectivoApp` | 3135 | `setDoc config/sistema` | `PATCH /config/sistema` |
| `actualizarCodigoRfidAnulacion` | 3163 | `setDoc config/sistema` | `PATCH /config/sistema` |
| `ejecutarForzarCierreSucursal` | 2453 | cloud function | `POST /cash-shifts/forzar-cierre` |
| `cerrarSesion` | 3181 | `signOut(auth)` | `NexusAuth.cerrarSesion()` |

### 1.3 Código muerto que hay que borrar, no traducir

`ejecutarForzarCierreSucursal` **ya llama a la cloud function y hace `return` en
la linea 2573**. Todo el `writeBatch` de 2575-2695 nunca se ejecuto.

### 1.4 No se puede migrar a medias

El interruptor es **por pagina, no por operacion**. Si el dashboard leyera de
Mongo y escribiera a Firestore, un cobro aprobado no apareceria en pantalla y
pareceria que se perdio el dato. **Leer y escribir migran juntos.**

Pasos:
1. Agregar los `<script>` de `nexus-data.js`, `nexus-realtime.js` y `nexus-auth.js`.
2. Cambiar las 12 lecturas y las 11 escrituras de arriba.
3. Dejar el interruptor en `'firestore'` y desplegar. Nada cambia todavia.
4. Probar: `NexusData.usarMongo('dashboard')`, recargar, hacer un cobro de prueba
   y confirmar que aparece en pantalla.
5. Validado eso, cambiar el default a `'mongo'`.

---

## ⏳ 2. Las otras 18 paginas

Todas son **mas simples** que el dashboard: en su mayoria `getDocs` + `setDoc` sin
transacciones. Candidatas naturales para empezar: `lin_tickets.html`,
`sucursales.html`, `usuarios.html`, `inventario.html`, `stock.html`,
`reportes.html`.

`nexus-data.js` ya resuelve el 90 %: mapa de colecciones, traduccion de `where` /
`orderBy` / `limit`, y las guardas de escritura que avisan cuando una coleccion no
se puede escribir por la via generica (en vez de devolver un 404 mudo).

**Orden recomendado:** solo-lectura primero (riesgo cero), despues las CRUD de
catalogos, y `pos.html` al final (es la mas critica).

---

## ⏳ 3. Limpieza de Firebase

- Quitar los SDK de Firestore/Auth de las 21 paginas.
- `firestore.rules` deja de tener efecto cuando nadie lee Firestore.
- **Conservar** la llave de servicio hasta terminar la migracion
  (`migrate-firestore.ts` la sigue usando).

### Decidir ANTES de borrar Firebase

| Pieza | Situacion |
|---|---|
| Recuperacion de contrasena | `index.html` todavia llama a la cloud function `restablecerPasswordConCodigo` (`functions/index.js:1261`). Hay que portar `solicitarCodigoRecuperacion` (:1136) o perder esa funcion. |
| `crearPedidoCliente` (:2842) | Alta de pedidos desde la app cliente. Verificar si sigue en uso. |
| Push (`enviarNotificacionPush` :2460) | Requiere FCM. |
| Analytics (`trackGa4Event` :240) | Se puede dejar como esta. |

---

## ⏳ 4. Operacion

### Antes del primer ingreso

```bash
npm run auth:pass -- <email> <password>
```

**Sin esto nadie puede entrar.** Los 62 usuarios migrados no tienen contrasena:
en Firebase vivian en Firebase Auth, no en Firestore, asi que la migracion no las
pudo traer.

### Despliegue

1. Desplegar el servidor.
2. Correr `npm run auth:pass` una vez para habilitar el primer admin.
3. Verificar `/health`.

**Proteger la API no rompe nada:** las paginas que siguen en Firestore no llaman
a `/api/v1`, asi que servidor y frontend se despliegan en cualquier orden.

### Infraestructura pendiente

- ⏳ **Redis sin provisionar** en Dokploy. Los guardias `redis.status !== 'ready'`
  lo toleran (no rompe), pero el cache y los locks de stock no funcionan.
- ⏳ `firebase deploy --only firestore:rules` si se sigue usando Firestore durante
  la transicion (la regla `cashFlows` estaba en `allow write: if false`).

---

## Decisiones abiertas (necesitan respuesta del negocio)

1. **Retencion de auditoria.** El TTL de 5 anios nunca funciono (Mongo ignora el
   TTL en indices compuestos), asi que la coleccion crece sin limite. Purgar
   auditoria es una decision fiscal, no tecnica.
2. **Evento `venta:actualizada`.** El cobro reusa `venta:creada` porque los 5
   eventos no incluyen "venta modificada". Funciona (todos disparan el mismo
   refetch), pero el nombre confunde. Agregarlo es barato.
3. **Matriz de roles.** Hoy `admin`/`supervisor` escriben config y
   `admin`/`supervisor`/`cajero` resuelven cobros. Confirmar que es la real.
4. **Rate limiter con varias replicas.** Es en memoria: con N replicas el limite
   efectivo se multiplica por N. Si se escala horizontal, mudarlo a Redis.

---

## Hallazgos que no conviene olvidar

- Las contrasenas **no se migraron** (vivian en Firebase Auth).
- `Order` es `strict: true`: los campos del cobro (`estadoAprobacionCobro`,
  `deudaAplicada`, `marcadoComoAbonado`...) **no estaban declarados y Mongoose los
  descartaba en silencio**. Ya estan en el modelo.
- El frontend manda ids de Firestore de 20 caracteres. Todo `/:id` usaba
  `findById` y fallaba con `CastError`. Resuelto con `filtroPorId()`.
- `firestore.rules` era la unica barrera de acceso. Al migrar a Mongo la API
  quedo abierta (incluido `POST /users` con `rol:'admin'`). Ya esta cerrada.
- La logica de caja completa ya estaba server-side en `functions/index.js`.
- La formula de "esperado" del arqueo esta en `utils/cashFlow.ts` con la cita de
  la linea original de cada funcion. **No cambiarla sin hablarlo.**
