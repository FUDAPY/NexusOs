# SPEC · NexusOS

> Documento de estado del proyecto. Complementa a `tasks/plan.md`,
> `tasks/todo.md` y al estado del control de versiones.
> Última actualización: 2026-10-02 · Medición local, no estimada.

---

## 1. Objetivo

Documentar el estado verificado del proyecto para que el trabajo continúe de
forma consistente, sin depender del historial de conversaciones anteriores.

Este documento describe el **estado**, no una funcionalidad pendiente. Cada
funcionalidad nueva requiere su propia especificación antes de implementarse.

## 2. Estado verificado del repositorio

### 2.1 Identidad

| Dato | Valor |
|---|---|
| Repositorio | `FUDAPY/NexusOs` |
| Rama activa | `main` |
| Licencia | MIT |
| Producto | POS / ERP / CRM multi-sucursal |

### 2.2 Stack (fijado por README, no negociable)

- Node.js `>=22` · TypeScript `5.7` en modo `strict` (**prohibido `any`**)
- Express `4.21` + Socket.IO `4.8` (namespace `/kds`)
- MongoDB `8.x` en **replica set** + Mongoose `8` · Redis `7`
- Frontend: HTML5 + Tailwind (SPA servida como estático) · Android vía Capacitor `7`
- Tests: Vitest · Lint: ESLint `9` `--max-warnings=0`

### 2.3 Arquitectura por capas (obligatoria)

```
routes/ → controllers/ → services/ → models/
```

Convenciones observadas: imports ESM con extensión `.js` aunque el fuente sea
TypeScript (NodeNext); `models/` en PascalCase; `routes/` en kebab-case.

### 2.4 Superficie actual

- **Backend:** 27 modelos Mongoose, ~55 endpoints de lectura vía
  `resource.factory`, flujo de venta/anulación/cobro/arqueo completo.
- **Frontend:** 24 rutas HTML. El núcleo (`nexus-api.js`, `nexus-data.js`,
  `nexus-realtime.js`, `nexus-auth.js`) ya está desacoplado de Firebase.
- **Tests:** 8 suites escritas — `acceso`, `anulacionAutorizacion`, `cashFlow`,
  `filtros`, `models`, `mongoId`, `response`, `resumen.integracion`.
- **Migración Firestore → Mongo:** backend completo; **frontend parcial**.

### 2.5 Verificación reproducible (medida 2026-10-02)

| Comprobación | Comando | Resultado |
|---|---|---|
| Tipos strict | `npm run typecheck` | ✅ **EXIT 0** |
| Tests | `node node_modules/vitest/vitest.mjs run` | ✅ **EXIT 0** |

**Resultado: 182 tests pasados · 0 fallidos · 7 skipped** (9,56 s)

| Suite | Tests |
|---|---:|
| `acceso` (control de acceso y roles) | 81 |
| `cashFlow` (cálculo de dinero del arqueo) | 30 |
| `models` | 28 |
| `anulacionAutorizacion` | 18 |
| `filtros` | 15 |
| `mongoId` | 5 |
| `response` | 5 |
| `resumen.integracion` | 7 *skipped* |

`tsc` pasa limpio en modo `strict`, lo que confirma que la prohibición de `any`
se sostiene en todo `server/src`. La suite `acceso` (81 tests) es la que
respalda el control de JWT y roles descrito en §2.6.

> `resumen.integracion.test.ts` aparece como *skipped* — las 7 pruebas están
> escritas pero no se ejecutan. **No contarlas como cobertura efectiva** hasta
> saber qué las desactiva (probablemente requieren MongoDB levantado).

### 2.5.1 Notas de entorno

Dos impedimentos afectaban a la verificación. Ambos corresponden al entorno,
no al código:

1. **Binario nativo de rollup ausente** → Vitest no arrancaba
   (`Cannot find module @rollup/rollup-linux-x64-gnu`).
   Causa: bug de npm con dependencias opcionales (npm/cli#4828).
2. **Shims de `node_modules/.bin` generados en Windows** → apuntan a `node.exe`
   (exit 127) y carecen del bit de ejecución (exit 126).
   Causa raíz: el árbol de dependencias se instaló en Windows y se copió a Linux.

**Consecuencia: en Linux, `npm test` y `npm run typecheck` no funcionan.**
Invocar directamente:

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.check.json
```

Solución definitiva pendiente: `rm -rf node_modules && npm ci` en Linux.

El paquete nativo de rollup **no** se añadió a `dependencies`: ataría el proyecto
a un único sistema operativo y rompería el desarrollo en Windows.

### 2.6 Seguridad — verificado

- Control de acceso JWT en toda la API. Único router público: `publicResourceRouter`
  (solo lectura, para `metas-publicas.html`).
- `app.ts` deja constancia del riesgo histórico: al dejar Firestore, la barrera
  `firestore.rules` desapareció y quedó una escalada de privilegios trivial
  (`POST /users` con `rol: 'admin'`). **Este es el motivo del `requiereAuth` global.**
- `.gitignore` cubre `.env*`, `*.pem`, `*.der`, `*.jks`, `google-services.json`,
  `.firebaserc`. Verificado: **ningún secreto está trackeado en git**.

## 3. Restricciones

1. Ningún cambio de código sin tarea activa en `tasks/todo.md`.
2. Todo código nuevo bajo `strict`, sin `any`.
3. Cero secretos: solo `.env` o gestor externo.
4. Nada se declara funcional sin ejecución real de la verificación.

## 4. Criterios de aceptación (medibles)

| # | Criterio | Cómo se verifica |
|---|---|---|
| CA-1 | Existen `SPEC.md`, `tasks/plan.md`, `tasks/todo.md` | `ls` |
| CA-2 | Typecheck y tests pasan | `vitest run` |
| CA-3 | Cero secretos versionados | `git ls-files \| grep -E '\.jks\|\.pem\|\.der\|google-services'` → vacío |
| CA-4 | Árbol de trabajo limpio al cerrar | `git status --short` |

## 5. Fuera de alcance

- Migrar `dashboard.html` y las páginas restantes con Firestore: requiere
  especificación propia (ver `docs/ROADMAP-NEXUS.md`).
- Reconstrucción de ventas y POS: excluidos por decisión de negocio
  (`docs/ROADMAP-ADMIN.md`).
- Cambios de stack, arquitectura o infraestructura.

## 6. Riesgos abiertos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R-1 | Frameworks legacy (`firebase.json`, `firestore.rules`, `functions/index.js`) siguen en el repo | Confusión operativa; riesgo de escribir código contra una API retirada | Marcar como legacy; ninguna tarea nueva los modifica |
| R-2 | Frontend con migración mixta (Firestore + API) | Doble fuente de verdad | Migración página por página con criterio de aceptación explícito |
| R-3 | `node_modules` instalado en Windows | Verificación local frágil | Reinstalar dependencias en Linux |
| R-4 | Suite de integración sin ejecutar | Cobertura real menor de lo aparente | Identificar la condición que la desactiva |

## 7. Supuestos

- `docs/ROADMAP-*.md` reflejan el estado real del proyecto.
- La aprobación de cada fase corresponde al responsable del repositorio.