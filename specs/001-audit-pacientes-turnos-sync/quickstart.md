# Quickstart: Validación de la Auditoría de Estabilidad

Esta guía describe cómo ejecutar y validar esta auditoría — no cómo usar AgendaMente. No hay entorno de prueba separado: todo se corre contra el Sheet de producción (ver `research.md`, Decisión 3), con datos etiquetados y removibles.

## Prerequisitos

1. Node.js y npm instalados (verificado disponibles: `node v24.15.0`, `npm 11.12.1`).
2. Acceso a la cuenta de Google dueña del proyecto Apps Script vinculado a la Web App actual (`API_URL` en `index.html:1284`).
3. El Script ID del proyecto Apps Script (Project Settings, dentro del editor en script.google.com) — necesario para `clasp clone`, no derivable de la URL de despliegue.
4. Acceso de edición al Google Sheet de producción (para poder crear/borrar filas de prueba etiquetadas).

## Paso 1 — Traer el código backend con clasp

```bash
npx @google/clasp login
```

Este comando abre un flujo OAuth en el navegador — **paso manual, debe completarlo Jonatan** (un agente no puede autorizar esto por su cuenta).

```bash
npx @google/clasp clone <SCRIPT_ID> --rootDir ./backend-appsscript
```

Resultado esperado: la carpeta `backend-appsscript/` queda poblada con el código real del backend (`.gs`, `appsscript.json`, `.clasp.json`).

## Paso 2 — Revisar el contrato de API contra el código real

Abrir `contracts/apps-script-api.md` y, archivo por archivo en `backend-appsscript/`, verificar cada uno de los 4 puntos de contrato listados ahí (generación de ID, uso de `flush()`, validación de `pacienteId`, manejo de errores).

## Paso 3 — Reproducir el bug crítico de forma controlada (User Story 1)

1. En el frontend en vivo, crear un paciente de prueba con nombre `ZZZ_AUDITORIA_<timestamp>` (por ejemplo `ZZZ_AUDITORIA_20260826_1200`).
2. Abrir el Google Sheet de producción, hoja "Pacientes", y verificar si la fila nueva tiene la columna `id` completa o vacía.
3. Si tiene ID: crear un turno para ese paciente y verificar en "Turnos" que el turno muestra el nombre correctamente al recargar la agenda.
4. Si no tiene ID: intentar crear igualmente un turno para ese paciente (reproduciendo el síntoma) y observar el comportamiento de la app (¿se bloquea la carga completa? ¿el turno queda huérfano?).
5. Anotar el resultado exacto de cada paso — esto alimenta el Hallazgo H1 (bug crítico) en el informe final.
6. **Borrar** la fila de paciente y cualquier turno de prueba creados, del Sheet de producción, al terminar.

## Paso 4 — Relevar el resto del flujo (User Story 2)

Recorrer, con el código de `backend-appsscript/` ya disponible, cada función involucrada en `create`/`update` de "Pacientes" y "Turnos", contrastando contra los puntos ya identificados por análisis estático en `research.md` ("Hallazgo preliminar") y `data-model.md` (asimetría de validación de `pacienteId`).

## Paso 5 — Verificar datos ya afectados en producción (User Story 3)

Sobre el Sheet de producción (sin modificarlo): listar manualmente cualquier fila de "Pacientes" con `id` vacío, y cualquier fila de "Turnos" cuyo `pacienteId` no corresponda a ningún paciente existente. Documentar cada caso encontrado, sin borrarlos todavía (la remediación es una recomendación del informe, no una acción de esta tarea — FR-009).

## Resultado esperado de esta auditoría

Un documento de hallazgos (a producir en la fase de tareas/implementación, no en este plan) que cumpla `SC-001` a `SC-005` de `spec.md`: causa raíz del bug crítico confirmada o hipótesis descartadas explícitamente, listado priorizado de todos los puntos de fragilidad, inventario de datos ya afectados en producción, y recomendaciones concretas y accionables para cada hallazgo — sin haber modificado datos de producción ni el código del producto.
