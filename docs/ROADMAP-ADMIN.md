# Roadmap · Panel Admin (NexusOS)

> **Objetivo:** que el panel administrativo completo quede funcional contra
> **MongoDB / la API**, módulo por módulo.
>
> El POS y la reconstrucción de ventas faltantes quedan **fuera de alcance** por
> decisión del negocio: se retoman después.

---

## 1. Estado medido (no estimado)

Medición real, archivo por archivo. Para reproducirla:

```powershell
cd frontend
foreach ($p in (Get-ChildItem *.html).Name) {
  $c = Get-Content $p -Raw
  "{0} | guardFB={1} | NexusData={2} | nexus-auth={3} | fsDirecto={4} | callable={5}" -f `
    $p,
    ([regex]::Matches($c,'onAuthStateChanged')).Count,
    ([regex]::Matches($c,'NexusData\.')).Count,
    ([regex]::Matches($c,'nexus-auth\.js')).Count,
    ([regex]::Matches($c,'getDocs|setDoc|updateDoc|addDoc|deleteDoc|onSnapshot|runTransaction|writeBatch|collection\(db|doc\(db')).Count,
    ([regex]::Matches($c,'httpsCallable')).Count
}
```

| Página | Líneas | guardFB | NexusData | nexus-auth | fsDirecto | callable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `dashboard.html` | 3130 | 2 | **19** | ✅ | 67 | 6 |
| `usuarios.html` | 607 | 2 | 3 | ✅ | 10 | 0 |
| `clientes.html` | 1221 | 2 | 0 | ❌ | 33 | 0 |
| `inventario.html` | 887 | 2 | 0 | ❌ | 20 | 0 |
| `lin_tickets.html` | 480 | 2 | 0 | ❌ | 18 | 0 |
| `produccion.html` | 594 | 2 | 0 | ❌ | 15 | 0 |
| `sucursales.html` | 494 | 2 | 0 | ❌ | 14 | 0 |
| `caja.html` | 961 | 2 | 0 | ❌ | 12 | 2 |
| `reportes.html` | 1345 | 2 | 0 | ❌ | 11 | 0 |
| `relatorio_cierres.html` | 562 | **0** | 0 | ❌ | 11 | 0 |
| `stock.html` | 737 | 2 | 0 | ❌ | 7 | 0 |
| `notificaciones.html` | 308 | 2 | 0 | ❌ | 6 | 0 |
| `auditoria_transacciones.html` | 524 | **0** | 0 | ❌ | 6 | 0 |
| `kds.html` | 472 | 2 | 0 | ❌ | 6 | 2 |
| `monitor_problemas.html` | 838 | 2 | 0 | ❌ | 6 | 0 |

**Lectura de la tabla:**

- **13 de 16 páginas** usan `onAuthStateChanged` → **rebotan al login y destruyen
  la sesión** (ver bloqueo B1).
- **Solo 2 páginas** usan `NexusData` → solo esas tienen capa de datos migrada.
- **`fsDirecto`** es el trabajo pendiente de cada página: cada llamada es una
  lectura/escritura que hoy va a Firestore y **falla con permission-denied**.
- **`callable`** = dependencia de Firebase Cloud Functions.
- **`dashboard.html`** es el caso especial: 19 usos de `NexusData` (la capa está
  escrita) pero **67 llamadas directas** que todavía no pasaron por ella.

---

## 2. Los tres bloqueos sistémicos

Se arreglan **una sola vez** y desbloquean todas las páginas. Van primero.

### B1 · El guard destruye la sesión 🔴

El patrón, repetido en 13 páginas:

```js
onAuthStateChanged(auth, (user) => {
    if (user) { ...cargar... } else { this.cerrarSesion(); }
});
```

`cerrarSesion()` no solo redirige: **hace `localStorage.removeItem('__pos_session')`**.

Como `index.html` ya NO autentica contra Firebase, ese callback recibe **siempre
`user === null`**. Resultado: la página te expulsa **y te borra la sesión**, con lo
que tampoco sirve ir a otra página.

**Por qué es lo primero:** una página a medio migrar **no debe expulsar al
usuario**. Mientras esto exista, cualquier otra mejora queda tapada: no se puede
llegar a la pantalla.

**Arreglo (patrón ya aplicado en `dashboard.html`, `usuarios.html`, `pos.html`):**

```js
// Aceptar tambien la sesion de NexusAuth (JWT), que es la que existe ahora.
if (user || (window.NexusAuth && window.NexusAuth.autenticado())) {
```

Y en el `<head>`:

```html
<script src="nexus-api.js"></script>
<script src="nexus-auth.js"></script>
<script src="nexus-data.js"></script>
```

`nexus-auth.js` **después** de `nexus-api.js`: al cargarse rehidrata el JWT en
`NexusAPI`. Sin él, todas las peticiones salen sin `Authorization` → 401.

### B2 · Falta el wiring de datos

Solo 2 páginas cargan `nexus-auth.js`. Las otras 14 no pueden hablar con la API
ni aunque su código esté migrado. Es parte de B1 pero se verifica aparte.

### B3 · Firestore niega todo

`firestore.rules` exige sesión de Firebase, y ya no hay. Cualquier lectura que
quede apuntando ahí **falla con un error ruidoso** (`Missing or insufficient
permissions`). No es un dato faltante: es una llamada al lugar equivocado.

**Consecuencia práctica:** una página no está "lista" hasta que su `fsDirecto`
llega a 0 (salvo los `callable`, que se resuelven aparte).

---

## 3. Reglas de trabajo

Las tres que evitan repetir los errores de esta migración:

1. **Compatibilidad de forma antes que reescritura.** Cuando el consumidor solo
   usa una parte de la API de Firestore (`snapshot.forEach`, `docChanges`, `size`),
   **no se reescribe la lógica**: se le entrega un objeto con la misma forma
   alimentado por `NexusData`. Ver `escucharProductosDesdeApi` en `pos.html` — 40
   líneas intactas, una línea cambiada.

2. **Ninguna página migrada expulsa al usuario.** Si no puede cargar datos,
   muestra el aviso; nunca cierra la sesión.

---

## 4. Qué colección usa cada página

Medido con `collection(db, "X")`. Las que aparecen vacías usan rutas armadas
(template literals, `doc(db, rutaPrivada)`), así que su superficie hay que
relevarla al abrirlas.

| Página | Colecciones de Firestore | Equivalente en la API |
| --- | --- | --- |
| `dashboard.html` | auditoria, products, users, branches, cierresCaja | `/audit-logs`, `/products`, `/users`, `/branches`, `/cash-closes` |
| `sucursales.html` | branches | `/branches` |
| `clientes.html` | branches, users | `/branches`, `/users` |
| `reportes.html` | branches | `/branches` |
| `inventario.html` | branches, products, inventoryMovements | `/branches`, `/products`, `/inventory-movements` |
| `notificaciones.html` | notifications | `/notifications` |
| `auditoria_transacciones.html` | branches | `/branches` |
| `usuarios.html` | — (ya usa `NexusData`) | ✅ migrado |
| `pos.html` | products (+6 rutas de ventas) | catálogo ✅; venta pendiente |
| `stock.html`, `produccion.html`, `kds.html`, `lin_tickets.html`, `relatorio_cierres.html`, `monitor_problemas.html`, `caja.html` | por relevar | — |

**Todas las colecciones que usan ya tienen recurso montado en la API**
(`server/src/routes/resource.routes.ts`), así que **no hace falta backend nuevo
para las lecturas**.

---

## 5. Fases, en orden de apalancamiento

### Fase 0 · Cimientos — B1 + B2 sobre las 13 páginas

**Un cambio mecánico, idéntico en todas.** Resultado: nada rebota, las sesiones
sobreviven y las páginas se pueden abrir (van a mostrar los paneles vacíos hasta
su fase propia, y hay que avisarlo en pantalla).

Páginas: `sucursales`, `clientes`, `reportes`, `stock`, `produccion`,
`inventario`, `kds`, `lin_tickets`, `notificaciones`, `monitor_problemas`,
`caja`, `auditoria_transacciones`, `relatorio_cierres`.

> `auditoria_transacciones` y `relatorio_cierres` tienen `guardFB = 0`: revisar
> **con qué** protegen hoy antes de tocarlas.

**Riesgo: 🟢 cero.** No toca datos ni lógica.

### Fase 1 · Las más baratas primero (riesgo: 🟢)

| Orden | Página | Trabajo |
| --- | --- | --- |
| 1 | `sucursales.html` | **una sola colección** (`branches`) → `NexusData.leer/crear/actualizar` |
| 2 | `notificaciones.html` | `notifications`, 6 llamadas |
| 3 | `stock.html` | 7 llamadas |
| 4 | `auditoria_transacciones.html` | 6 llamadas, sin guard Firebase |
| 5 | `relatorio_cierres.html` | 11 llamadas, sin guard Firebase |

**Por qué estas:** una colección cada una, sin transacciones ni tiempo real. Son
las que dejan el panel "usable" más rápido y validan el patrón.

### Fase 2 · Dashboard (riesgo: 🟡)

Es el caso especial: **la capa migrada ya está escrita** (19 usos de `NexusData`,
9 bloques `esMongo('dashboard')`), pero quedan **67 llamadas directas**.

Trabajo: terminar de pasar por `NexusData` las que faltan, empezando por
`cargarVentasTurnoUnaVez` (la que falla hoy) y los 6 `httpsCallable`.

### Fase 3 · Módulos medianos (riesgo: 🟡)

`inventario.html` (20), `produccion.html` (15), `lin_tickets.html` (18),
`reportes.html` (11), `monitor_problemas.html` (6).

`inventario.html` es el más delicado del grupo: cruza `products` con
`inventoryMovements`.

### Fase 4 · Los difíciles (riesgo: 🔴)

| Página | Por qué es difícil |
| --- | --- |
| `clientes.html` | 33 llamadas, `writeBatch`, saldos/deudas → toca plata |
| `caja.html` | 12 llamadas + 2 Cloud Functions; es el arqueo |
| `kds.html` | tiempo real (`onSnapshot`) → requiere `NexusRealtime`/`vigilar()` |

Se hacen **al final y con `dryRun`** donde toque dinero.

### Fase 5 · Backend pendiente

| # | Qué | Por qué |
| --- | --- | --- |
| 5.1 | **`POST /cash-shifts/abrir`** | No existe. Sin esto no hay turno nuevo, y el POS no puede vender |
| 5.2 | **`npm run mongo:indices`** | En producción `autoIndex` es `false`: **los índices declarados en los esquemas no se crean**. Ver 5.3 |
| 5.3 | **Limpiar `turnoId` duplicados** | Hay turnos con el mismo `turnoId` (San Benito: 9 turnos, 5 distintos). **Bloquea el índice único de 5.2** |
| 5.4 | Reconstrucción de ventas faltantes | Fuera de alcance por decisión del negocio |
| 5.5 | POS: la venta | La etapa más crítica; después del panel |

> **5.2 y 5.3 están relacionados y son la causa raíz de los turnos colgados:**
> el POS buscaba su turno por `cajeroId`, que `strict` descartaba, así que creaba
> uno nuevo en cada apertura. Sin el índice único, esos duplicados no se
> rechazaron nunca. Ambos ya están corregidos en el código (`99d45ac`); falta
> crear los índices y limpiar lo viejo.

---

## 6. Definición de "terminado" por página

Una página se considera cerrada cuando cumple **las cinco**:

1. **No rebota y no destruye la sesión** (B1/B2 aplicados).
2. **`fsDirecto = 0`** — ninguna llamada a Firestore; todo por `NexusData`/`NexusAPI`.
3. **Carga sus datos reales** desde Mongo (verificado con datos, no "sin error").
4. **Sus escrituras funcionan** (o quedan explícitamente deshabilitadas con aviso,
   como el borrado de usuarios antes de la decisión).
5. **Si toca plata o stock, tiene modo simulación.**

---

## 7. Orden recomendado de ejecución

```
Fase 0  (cimiento)            ← desbloquea todas las pantallas
  ↓
Fase 1  sucursales → notificaciones → stock → auditoria → relatorio
  ↓
Fase 5.1 abrir turno          ← desbloquea el POS en paralelo
  ↓
Fase 2  dashboard
  ↓
Fase 3  inventario → produccion → lin_tickets → reportes → monitor
  ↓
Fase 5.2/5.3 indices + limpieza de duplicados
  ↓
Fase 4  clientes → caja → kds
  ↓
Fase 5.5 POS: la venta
```

---

## 8. Fase 5.5 · La venta — análisis de huecos (medido, no estimado)

El POS cobra con **un solo `runTransaction`** (`pos.html:3533` en adelante) que hace
**cinco** cosas. El backend hoy cubre **dos y media**. Escribir esto antes de tocar
plata es a propósito: es la pieza donde un error se cobra mal.

### Lo que hace el POS (evidencia: `pos.html`)

| Paso | Dónde |
| --- | --- |
| Descuenta stock y deja `inventoryMovements` | `aplicarDescuentoStockEnTransaccion`, `obtenerDescuentosStockPendientes` (~3536) |
| **Crea** la venta, o **actualiza** el ticket pendiente si es una mesa recuperada | ~3542 |
| Actualiza los **puntos y la deuda del CLIENTE** (`deltaPuntosCliente`) | ~3507 |
| Descuenta **insumos de producción** (`produccionConfig`) | ~795-799 |
| Valida el **PIN de crédito** | `confirmarPinCredito` (~1301) |

### Lo que da `POST /orders` (`order.service.ts:121`)

| Sí hace | No hace |
| --- | --- |
| Resuelve productos y valida stock (`prepareItems`) | ❌ **No actualiza los puntos ni la deuda del cliente** |
| Descuenta stock **atómico** con guarda anti-sobreventa (`stock >= cantidad`) y marca `agotado` | ❌ **No actualiza tickets pendientes**: siempre CREA |
| Crea la `Order` con `total`, `subtotal`, `discountAmount`, `noAfectaCaja`, `puntosOtorgados`, `puntosCanjeados`, `detalleEfectivo`, `turnoId` | ❌ **No toca `produccionConfig`** |
| Marca `estadoPago: 'pendiente'` si el método es Crédito, `'pagado'` si no | ❌ **No valida el PIN de crédito** |
| Todo dentro de **una transacción** | ❌ No hay endpoint para **cobrar una mesa** (cerrar el pendiente) |

> **Ojo con esto:** `puntosOtorgados` y `puntosCanjeados` se guardan **en la orden**,
> pero el **saldo del cliente es otro documento**. Hoy el POS mueve los dos; la API
> solo el primero. Migrar solo la llamada dejaría **el ticket con los puntos pero al
> cliente sin abonárselos**: inconsistencia silenciosa, que es lo peor que puede pasar
> con plata.

### Plan por pasos (cada uno verificable por separado)

| Paso | Qué | Dónde | Riesgo |
| --- | --- | --- | --- |
| **A** | Que `createOrder` actualice **puntos y deuda del cliente** dentro de la MISMA transacción | backend | 🔴 pero acotado |
| **B** | Endpoint para **cobrar una cuenta pendiente** (mesa): pasar la orden de `pendiente` a `pagado` descontando stock y ajustando al cliente | backend | 🔴 acotado |
| **C** | El POS: cambiar `runTransaction(...)` por `NexusAPI.post('/orders', ...)` **un flujo por vez**, empezando por **venta directa en efectivo** (el más simple y el más usado) | `pos.html` | 🔴 |
| **D** | Insumos de producción (`produccionConfig`) | backend + POS | 🟡 |
| **E** | PIN de crédito | backend | 🟡 |

**Orden sugerido:** A → C (solo venta directa) → B → D → E.

**Regla para este bloque:** un flujo por vez, nunca dos. Cada uno se prueba contra la
base con un producto de prueba y se confirma que el stock, el saldo del cliente y el
ticket quedaron consistentes entre sí. Si algo no cuadra, se revierte ese paso y no se
sigue.

**Por qué no se hizo de una:** el cobro toca **stock + saldo del cliente + ticket** en
una transacción. Un cambio mal hecho acá no se nota como un error: se nota semanas
después como un descuadre de stock o un cliente con puntos de más, y a esa altura no
se sabe qué venta lo causó.
