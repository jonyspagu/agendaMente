---
description: "Task list for Auditoría de Estabilidad — Sincronización Pacientes-Turnos"
---

# Tasks: Auditoría de Estabilidad — Sincronización Pacientes-Turnos

**Input**: Design documents from `/specs/001-audit-pacientes-turnos-sync/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/apps-script-api.md](./contracts/apps-script-api.md), [quickstart.md](./quickstart.md)

**Tests**: No se incluyen tareas de test automatizado — esta auditoría no produce código de producto, y la spec no pidió TDD. La "prueba" de cada historia es la reproducción manual descrita en sus propias tareas.

**Entregable único**: `specs/001-audit-pacientes-turnos-sync/informe-auditoria.md` — el informe de hallazgos priorizados (FR-009). Ninguna tarea de esta lista modifica `index.html` ni despliega cambios de backend: es diagnóstico, no implementación (ver Asunciones de spec.md).

**Organization**: Tareas agrupadas por user story (US1, US2, US3), en el orden de prioridad P1 → P2 → P3 de spec.md.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Puede ejecutarse en paralelo (archivos/áreas distintas, sin dependencias)
- **[Story]**: A qué user story pertenece (US1, US2, US3)

## Path Conventions

- Frontend ya existente: `index.html` (raíz del repo) — solo lectura en esta auditoría.
- Backend a clonar: `backend-appsscript/` (raíz del repo, ver `plan.md` → Project Structure).
- Entregable: `specs/001-audit-pacientes-turnos-sync/informe-auditoria.md`.

---

## Phase 1: Setup

**Purpose**: Preparar el espacio de trabajo de la auditoría antes de tocar código o datos.

- [ ] T001 Crear `specs/001-audit-pacientes-turnos-sync/informe-auditoria.md` con el esqueleto de secciones: Resumen Ejecutivo, Hallazgos (uno por severidad, con los campos de `data-model.md` → "Hallazgo de auditoría": id, título, severidad, ubicación, causa raíz, evidencia, recomendación, requiere_backend), Anexo de Datos Afectados en Producción, y Checklist de Success Criteria (SC-001 a SC-005 de `spec.md`)
- [ ] T002 [P] Confirmar acceso de edición al Google Sheet de producción (hojas "Pacientes", "Turnos", "Cobros") — necesario para las pruebas controladas de las Fases 3 a 5

**Checkpoint**: Documento de informe creado y acceso de datos confirmado.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Acceso al código backend real, sin el cual US1 y US2 no pueden confirmar causa raíz (solo podrían quedarse en hipótesis).

**⚠️ CRITICAL**: Ninguna tarea de US1/US2 que referencie `backend-appsscript/` puede empezar hasta cerrar esta fase.

- [X] T003 Ejecutar `npx @google/clasp login` para autenticar con la cuenta de Google dueña del proyecto Apps Script — **paso manual interactivo (OAuth en navegador), lo debe completar Jonatan** (ver `research.md` → Decisión 1) — *completado por el usuario antes de esta sesión*
- [X] T004 Obtener el Script ID del proyecto Apps Script vinculado a la Web App actual (Project Settings, dentro del editor en script.google.com — no se puede derivar del `API_URL` de despliegue en `index.html:1284`) — *completado por el usuario antes de esta sesión*
- [X] T005 Ejecutar `npx @google/clasp clone <SCRIPT_ID> --rootDir ./backend-appsscript` para traer el código backend real al repo — *completado por el usuario; código confirmado en `backend-appsscript/Código.js`*
- [X] T006 Listar los archivos `.gs` resultantes en `backend-appsscript/` e identificar cuáles contienen las funciones `create`/`update`/`delete` para las hojas "Pacientes" y "Turnos" — anotar los nombres de archivo/función en `informe-auditoria.md` (sección de referencia interna) para uso en las fases siguientes

**Checkpoint**: `backend-appsscript/` disponible localmente con las funciones relevantes identificadas — US1 y US2 pueden empezar.

---

## Phase 3: User Story 1 - Diagnosticar la causa raíz del bug crítico de IDs de paciente (Priority: P1) 🎯 MVP

**Goal**: Confirmar, con evidencia reproducida, en qué punto exacto del flujo un paciente nuevo pierde su ID antes de persistirse en "Pacientes", y cómo eso deja turnos sin nombre vinculado.

**Independent Test**: Crear un paciente de prueba y un turno para él, siguiendo `quickstart.md` Paso 3, registrando en cada paso si el dato se comportó como se esperaba, hasta aislar el punto exacto de falla.

### Implementation for User Story 1

- [X] T007 [US1] En `backend-appsscript/`, revisar la función que maneja `sheet: "Pacientes", action: "create"`: documentar cómo genera y asigna el ID del paciente (autoincremento, `getLastRow()`, UUID, u otro) y si llama a `SpreadsheetApp.flush()` antes de devolver la respuesta — registrar hallazgo preliminar en `informe-auditoria.md` — **resultado: `getNextId` genera bien el ID; `buildRow` usa `h === "id"` estricto (sin trim/lowercase) para decidir en qué columna escribirlo — candidato a causa raíz; `flush()` SÍ está presente y en el orden correcto**
- [X] T008 [US1] Contrastar lo encontrado en T007 contra los puntos 1 y 2 de `contracts/apps-script-api.md` (garantía de que `res.id` corresponde a lo persistido; posible condición de carrera por falta de `flush()` antes de armar `res.pacientes`) y marcar cada punto como confirmado o refutado — **punto 1 (flush): refutado como causa — el flush está bien puesto; punto 2 (res.id ≠ lo persistido): confirmado como mecanismo real — `res.id` puede ser válido aunque la celda quede vacía, ver H1**
- [X] ~~T009~~ [US1] Reproducir en producción: crear un paciente de prueba con nombre `ZZZ_AUDITORIA_<timestamp>` desde el frontend en vivo y verificar en la hoja "Pacientes" si la columna `id` quedó completa o vacía (`quickstart.md` Paso 3.1-3.2) — **NO EJECUTADA: no fue necesaria.** Jonatan confirmó por inspección directa que la celda A1 de "Pacientes" dice `Id` (vs. `id` en "Turnos"), lo cual por sí solo confirma la causa raíz sin crear ningún dato de prueba
- [X] ~~T010~~ [US1] Si el paciente de T009 recibió un ID válido: crear un turno de prueba... (`quickstart.md` Paso 3.3) — **NO EJECUTADA: superflua, ver T009**
- [X] ~~T011~~ [US1] Si el paciente de T009 NO recibió un ID válido: intentar igualmente crear un turno de prueba... (`quickstart.md` Paso 3.4) — **NO EJECUTADA: superflua, ver T009**
- [X] T012 [US1] Analizar el mecanismo ya identificado por análisis estático en `index.html:1556-1562` (merge optimista de `agregarPaciente`, que acepta `nuevoId = Number(res.id)` sin verificar que exista en `res.pacientes`) y determinar si esto es la causa que propaga el bug hacia la UI, o si el origen real está solo del lado del backend confirmado en T007 — **resultado: el origen real es el backend (`buildRow`); el merge optimista del frontend no causa el bug pero lo enmascara, dejando a la usuaria sin ninguna alerta**
- [X] ~~T013~~ [US1] Eliminar del Sheet de producción cualquier fila de paciente/turno de prueba creada en T009-T011 (`quickstart.md` Paso 3.6) y confirmar que no queda residuo — **NO EJECUTADA: no se creó ningún dato de prueba, nada que limpiar**
- [X] T014 [US1] Redactar el Hallazgo H1 (bug crítico) en `informe-auditoria.md`: causa raíz confirmada (o hipótesis explícitamente descartadas si no se pudo confirmar con certeza), ubicación exacta en frontend y/o backend, evidencia recopilada en T007-T012, y recomendación de corrección concreta — cumpliendo SC-001 — **CERRADO: causa raíz confirmada (header `Id` vs `id`), con dos recomendaciones (fix de dato sin código, y fix de robustez en `buildRow`)**

**Checkpoint**: ✅ US1 CERRADO — causa raíz del bug crítico confirmada y documentada en el informe (`Id` vs `id` en el header de "Pacientes"), sin haber creado ni modificado ningún dato en producción. US2 y US3 quedan fuera del alcance de esta ejecución, a pedido explícito del usuario.

---

## Phase 4: User Story 2 - Auditar el flujo end-to-end en busca de otros puntos de falla (Priority: P2)

**Goal**: Relevar el resto del flujo de guardado/sincronización Turnos↔Pacientes para encontrar fragilidades más allá del síntoma ya diagnosticado en US1.

**Independent Test**: Recorrer cada función involucrada en creación/lectura de pacientes y turnos (frontend y backend) y producir un listado de hallazgos con ubicación, severidad y causa raíz, independientemente del resultado de US1.

### Implementation for User Story 2

- [ ] T015 [P] [US2] En `backend-appsscript/`, revisar la función que maneja `sheet: "Turnos", action: "create"`: documentar si valida que `data.pacienteId` corresponda a un paciente existente antes de guardar, o si acepta cualquier valor sin validar (contrato punto 3 en `contracts/apps-script-api.md`)
- [ ] T016 [P] [US2] En `backend-appsscript/`, revisar todas las funciones de escritura (create/update/delete de Pacientes, Turnos, Cobros) y verificar presencia y ubicación de `SpreadsheetApp.flush()` en cada una, siguiendo el Principio III de la constitución
- [ ] T017 [P] [US2] Analizar la asimetría de validación ya identificada entre `aplicarDataset` (`index.html:1387-1399`, bloquea la carga completa si algún `Paciente.id` no es numérico) y `normalizarTurno` (`index.html:1346-1349`, convierte `pacienteId` a `Number` sin validar `Number.isFinite`) — documentar como hallazgo de asimetría
- [ ] T018 [P] [US2] Analizar si `PacienteSearchSelect` (selector de paciente al crear un turno) puede ofrecer un paciente cuyo ID no está realmente confirmado en el servidor, dado que lee del estado local `pacientes` en memoria en vez de releer del backend en el momento de la selección
- [ ] T019 [P] [US2] Verificar los puntos 3 y 4 de `contracts/apps-script-api.md` no cubiertos en US1 (validación de `pacienteId` en creación de turno; manejo de `ok: false` vs. `ok: true` con datos parcialmente inválidos) contra el código real en `backend-appsscript/`
- [ ] T020 [US2] Redactar los Hallazgos H2..Hn en `informe-auditoria.md` (uno por cada punto de fragilidad de T015-T019), cada uno con severidad (crítico/medio/bajo), ubicación, causa raíz y recomendación — cumpliendo SC-002

**Checkpoint**: US2 cerrado — listado completo de fragilidades del flujo end-to-end documentado en el informe.

---

## Phase 5: User Story 3 - Verificar y remediar datos ya afectados en producción (Priority: P3)

**Goal**: Determinar si ya existen en producción pacientes con ID vacío o turnos con referencia de paciente inválida, y dejar una remediación propuesta para cada caso.

**Independent Test**: Revisar el estado actual de "Pacientes" y "Turnos" en producción, listar cualquier fila afectada, y proponer una acción de remediación para cada una.

### Implementation for User Story 3

- [ ] T021 [P] [US3] Revisar manualmente la hoja "Pacientes" en producción y listar todas las filas con `id` vacío o no numérico (`quickstart.md` Paso 5)
- [ ] T022 [P] [US3] Revisar manualmente la hoja "Turnos" en producción y listar todas las filas cuyo `pacienteId` no corresponde a ningún paciente existente en "Pacientes" (`quickstart.md` Paso 5)
- [ ] T023 [US3] Para cada fila listada en T021/T022, proponer una acción de remediación concreta (completar el ID manualmente, corregir el vínculo del turno, marcar para revisión manual, etc.) que no genere pérdida de historial clínico ni duplicación de pacientes — sin ejecutarla (FR-009)
- [ ] T024 [US3] Agregar el inventario completo de datos afectados y sus remediaciones propuestas como Anexo en `informe-auditoria.md` — cumpliendo SC-003

**Checkpoint**: US3 cerrado — inventario de datos ya afectados en producción documentado con plan de remediación, sin haberlos modificado.

---

## Phase 6: Polish & Cierre del Informe

**Purpose**: Consolidar el informe y verificar que cumple los criterios de éxito de la spec antes de darlo por entregado.

- [ ] T025 [P] Redactar el Resumen Ejecutivo en `informe-auditoria.md`: hallazgos más críticos primero, referencia cruzada a SC-001..SC-005
- [ ] T026 Verificar, hallazgo por hallazgo, que cada uno indica explícitamente si `requiere_backend` (y por lo tanto requerirá una nueva implementación de Apps Script antes de poder corregirse, Principio II) — cumpliendo SC-004 y SC-005
- [ ] T027 Confirmar que ningún dato de producción quedó modificado, huérfano o sin limpiar como efecto secundario de esta auditoría (revisar cierre de T013 y cualquier otro dato de prueba creado durante US2/US3)
- [ ] T028 Recorrer `informe-auditoria.md` completo contra el checklist de Success Criteria (SC-001 a SC-005 de `spec.md`) y marcar cada uno como cumplido antes de considerar la auditoría cerrada

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias — puede empezar de inmediato.
- **Foundational (Phase 2)**: depende de Setup — bloquea toda tarea de US1/US2 que referencie `backend-appsscript/`. US3 no depende de esta fase (solo necesita acceso al Sheet, ya confirmado en T002), pero por orden de prioridad se ejecuta después de US1/US2.
- **User Stories (Phase 3-5)**: dependen de Foundational. Recomendado en orden P1 → P2 → P3 dado que P2 se apoya en el acceso a backend ya usado en P1, y P3 es la de menor prioridad.
- **Polish (Phase 6)**: depende de que las tres user stories estén cerradas (consolida sus hallazgos en un único informe).

### User Story Dependencies

- **US1 (P1)**: depende de Foundational (Phase 2). No depende de US2/US3.
- **US2 (P2)**: depende de Foundational (Phase 2). Independiente de US1, aunque reutiliza el mismo acceso a `backend-appsscript/`.
- **US3 (P3)**: depende solo de Setup (T002, acceso al Sheet). No depende de US1/US2 ni de Foundational — podría adelantarse si hay capacidad, aunque el orden recomendado es dejarla última por prioridad.

### Parallel Opportunities

- T001 y T002 (Setup) pueden correr en paralelo.
- Dentro de Foundational, T003→T004→T005→T006 son estrictamente secuenciales (cada paso depende del anterior).
- Dentro de US1, T007-T013 son mayormente secuenciales (cada paso de reproducción depende del anterior); T014 depende de todos.
- Dentro de US2, T015-T019 son independientes entre sí (distintas funciones/archivos a revisar) y pueden marcarse `[P]`; T020 depende de todas.
- Dentro de US3, T021 y T022 son independientes (hojas distintas) y pueden marcarse `[P]`; T023 depende de ambas.
- US1, US2 y US3 pueden trabajarse en paralelo por distintas personas una vez cerrada Foundational (T002 para US3), aunque al ser una auditoría de una sola persona se recomienda el orden secuencial P1 → P2 → P3.

---

## Parallel Example: User Story 2

```bash
# Lanzar juntas las revisiones independientes de backend/frontend de US2:
Task: "Revisar función Turnos/create en backend-appsscript/ (validación de pacienteId)"
Task: "Revisar uso de flush() en todas las escrituras de backend-appsscript/"
Task: "Analizar asimetría aplicarDataset vs. normalizarTurno en index.html"
Task: "Analizar PacienteSearchSelect (estado local vs. servidor)"
```

---

## Implementation Strategy

### MVP First (User Story 1 solamente)

1. Completar Phase 1: Setup.
2. Completar Phase 2: Foundational (crítico — sin acceso al backend, US1 solo puede documentar hipótesis, no causa raíz confirmada).
3. Completar Phase 3: User Story 1.
4. **Parar y validar**: el Hallazgo H1 en `informe-auditoria.md` debe dejar la causa raíz del bug crítico confirmada o las hipótesis explícitamente descartadas (SC-001).
5. Esto ya es un entregable útil por sí solo: responde la pregunta más urgente del usuario, incluso si el resto de la auditoría (US2/US3) se pospone.

### Incremental Delivery

1. Setup + Foundational → acceso listo.
2. US1 → informe con causa raíz del bug crítico (MVP de esta auditoría).
3. US2 → informe ampliado con el resto de los puntos de fragilidad.
4. US3 → informe completo con inventario de datos ya afectados y remediación propuesta.
5. Polish → informe final consolidado y verificado contra los 5 Success Criteria.

## Notes

- `[P]` = archivos o funciones distintas dentro de `backend-appsscript/`/`index.html`, sin dependencia entre sí — pero toda tarea que **escribe** en `informe-auditoria.md` (T001, T014, T020, T024, T025-T028) es secuencial respecto de las demás tareas de escritura, para evitar conflictos de edición sobre el mismo archivo.
- Ninguna tarea de esta lista modifica `index.html` ni el backend de Apps Script real — es diagnóstico puro, conforme a FR-009 y FR-011 de `spec.md`.
- T003 (login de clasp) requiere intervención manual del usuario; no se puede automatizar.
- Detenerse en cualquier checkpoint para validar una historia de forma independiente antes de continuar con la siguiente.
