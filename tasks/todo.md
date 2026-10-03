# TODO · Estado del proyecto

> Panel de control. Una casilla marcada refleja un resultado verificado por
> ejecución, no una suposición.
> Última actualización: 2026-10-02

**Estado global:** 3 / 3 completadas ✅ · baseline verificado

---

## Tarea 1 — Verificar el baseline reproducible

- [x] Ejecutar `typecheck` → **EXIT 0**
- [x] Ejecutar `test` (`vitest run`) → **EXIT 0 · 182 pasados / 0 fallidos / 7 skipped**
- [x] Registrar el resultado real en `SPEC.md`

> **Entorno reparado durante esta tarea** (fallos que NO eran del código):
> 1. Faltaba `@rollup/rollup-linux-x64-gnu` → Vitest no arrancaba. **Resuelto.**
> 2. Los shims de `node_modules/.bin` son de **Windows** (`exec: node.exe`) y
>    venían sin bit de ejecución. Causa raíz: `node_modules` se instaló en
>    Windows y se copió a Linux.
>
> ⚠️ **En Linux, `npm test` y `npm run typecheck` NO funcionan.** Usar siempre:
> ```bash
> node node_modules/vitest/vitest.mjs run
> node node_modules/typescript/bin/tsc -p tsconfig.check.json
> ```
> Fix definitivo pendiente: `rm -rf node_modules && npm ci` en Linux.
>
> 📌 `resumen.integracion.test.ts` → 7 tests *skipped*. Escritos pero no
> ejecutados. No cuentan como cobertura hasta averiguar qué los desactiva.

## Tarea 2 — Auditar higiene de secretos

- [x] Verificar `.gitignore` cubre `.env*`, `*.pem`, `*.der`, `*.jks`,
      `google-services.json`, `.firebaserc`
- [x] Confirmar con `git ls-files` que **ninguno** está trackeado
- [x] Sin cambios necesarios en `.gitignore`

> **Riesgo residual:** el material de firma reside en el directorio de trabajo,
> fuera del control de versiones. Un `git add -f` lo publicaría. No modificar
> esos archivos salvo petición explícita.

## Tarea 3 — Documentar el estado del proyecto

- [x] Crear `SPEC.md`
- [x] Crear `tasks/plan.md`
- [x] Crear `tasks/todo.md`
- [x] Habilitar su versionado en `.gitignore`

---

## Bloqueos de entorno

- [x] ~~Binarios nativos de rollup ausentes~~ → **RESUELTO**
      (`npm i @rollup/rollup-linux-x64-gnu`, exit 0)
- [ ] **Shims de `node_modules/.bin` generados en Windows** → `npm test` y
      `npm run typecheck` no funcionan en Linux.
      Workaround activo: invocar con `node node_modules/<pkg>/<entry>.mjs`.
      Fix definitivo: `cd server && rm -rf node_modules && npm ci`.
      **Requiere autorización** (borra y reinstala todo el árbol de deps).

## Backlog (sin SPEC → no autorizado)

- [ ] Migrar `dashboard.html` de Firestore a la API (67 llamadas directas)
- [ ] Migrar las 18 páginas restantes con Firestore
- [ ] Marcar o retirar el legacy: `firebase.json`, `firestore.rules`,
      `functions/index.js`, `firestore.indexes.json`

## Próximo paso inmediato

Baseline verificado y entorno reparado. Opciones, **esperando tu decisión**:

- **A)** `rm -rf node_modules && npm ci` → fix definitivo de los shims Windows.
- **B)** Especificar la migración de `dashboard.html` (Fase 1: SPEC propia).
- **C)** Commit de los artefactos de estado.

Ninguna opción se ejecuta sin tu autorización explícita.