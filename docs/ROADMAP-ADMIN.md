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

**Sugerencia:** arrancar por **Fase 0 + `sucursales.html`** en el mismo paso. Con
eso el panel deja de expulsar al usuario y **una pantalla completa queda
funcional**, que es la mejor forma de validar el patrón antes de repetirlo 12
veces.
