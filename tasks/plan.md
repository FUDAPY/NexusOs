# Plan · Estado del proyecto

> Complementa a `SPEC.md`. Tareas ordenadas por dependencia.
> `- [ ]` pendiente · `- [x]` completada · `[-]` en curso

---

## Tarea 1 — Verificar el baseline reproducible

**Motivo:** el roadmap afirma que las pruebas pasan, pero esa condición solo se
confirma mediante ejecución. Sin un baseline no hay forma de detectar
regresiones en fases posteriores.

**Archivos:** ninguno (solo lectura y ejecución).
**Depende de:** nada.

## Tarea 2 — Auditar higiene de secretos

**Motivo:** el repositorio contiene material de firma (`*.jks`, `*.der`,
`*.pem`) y `google-services.json` en el directorio de trabajo. Basta un
`git add` forzado para publicarlos.

**Archivos:** `.gitignore`, solo si la auditoría revela un hueco.
**Depende de:** nada.

## Tarea 3 — Documentar el estado del proyecto

**Motivo:** `SPEC.md`, `tasks/plan.md` y `tasks/todo.md` permiten continuar el
trabajo sin depender del historial de conversaciones.

**Archivos:** `SPEC.md`, `tasks/plan.md`, `tasks/todo.md`, `.gitignore`.
**Depende de:** Tareas 1 y 2 (la especificación registra el resultado medido).

---

## Dependencias

```
Tarea 1 ─┐
         ├─→ Tarea 3
Tarea 2 ─┘
```

Las tareas 1 y 2 son paralelizables; ambas alimentan el contenido de la tarea 3.

## Bloque siguiente (no autorizado)

Migración de `dashboard.html` a la API. Requiere especificación propia y
aprobación explícita antes de convertirse en tareas de este plan.