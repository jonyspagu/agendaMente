# Implementation Plan: Auditoría de Estabilidad — Sincronización Pacientes-Turnos

**Branch**: `001-audit-pacientes-turnos-sync` | **Date**: 2026-08-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-audit-pacientes-turnos-sync/spec.md`

## Summary

Auditoría técnica end-to-end (no una feature nueva) del flujo de creación de pacientes y turnos en AgendaMente, para diagnosticar la causa raíz del bug crítico reportado (pacientes que quedan sin ID persistente en la hoja "Pacientes", lo que deja turnos sin nombre vinculado) y para identificar cualquier otro punto de fragilidad en la sincronización Turnos↔Pacientes. El entregable es un **informe de hallazgos priorizados** (causa raíz, ubicación, severidad, recomendación) — no se implementan correcciones en esta tarea. El enfoque técnico combina: (a) análisis estático del frontend ya versionado (`index.html`), (b) análisis estático del backend de Apps Script, obtenido vía `clasp` porque hoy no está versionado en este repo, y (c) reproducción controlada y mínima sobre el Sheet de producción (sin entorno de prueba separado), usando datos de prueba claramente identificables para no contaminar los datos reales de Lupita.

## Technical Context

**Language/Version**: JavaScript (frontend: ES2019+ vía `<script type="text/babel">`/React global, sin build step ni JSX fuente separada); backend: Google Apps Script (V8 runtime, JavaScript ES2019-ish) — código aún no accedido, se confirma tras `clasp clone`.

**Primary Dependencies**: React 18 (cargado por CDN dentro de `index.html`, no hay `package.json`); backend usa `SpreadsheetApp` / `ContentService` de Apps Script (APIs nativas, sin dependencias externas esperables). `clasp` (`@google/clasp`) se usa solo como herramienta de auditoría vía `npx`, no como dependencia de runtime del producto.

**Storage**: Google Sheets de producción, hojas "Pacientes", "Turnos" y "Cobros" (esquema de columnas confirmado en `index.html:1310-1331`: `CAMPOS_PACIENTE`, `CAMPOS_TURNO`, `CAMPOS_COBRO`). No existe entorno de prueba separado.

**Testing**: No hay suite de tests automatizados en el repo (no hay `package.json` ni framework de test). La verificación de esta auditoría es manual: reproducción paso a paso end-to-end sobre producción, con datos de prueba etiquetados, siguiendo los escenarios de aceptación de la spec.

**Target Platform**: Aplicación web de una sola página, hosteada en GitHub Pages, consumiendo un Web App de Apps Script; un único tenant, una usuaria activa (Lupita).

**Project Type**: Auditoría/diagnóstico sobre una aplicación web existente (frontend estático + backend serverless). No es desarrollo de una feature nueva.

**Performance Goals**: N/A — esta auditoría no define ni modifica objetivos de performance del producto.

**Constraints**:
- No modificar datos reales de producción durante la auditoría (FR-012); cualquier dato de prueba debe quedar claramente identificable y removible.
- El acceso al código backend requiere `clasp login` (flujo OAuth interactivo en navegador) — es un paso manual que debe completar el usuario (Jonatan), no automatizable por un agente.
- Cumplir Principios I, II, III, IV y V de la constitución (`.specify/memory/constitution.md`) — ver Constitution Check.
- El entregable es únicamente el informe (FR-009); no se despliegan cambios de backend ni frontend en esta tarea.

**Scale/Scope**: Un solo frontend (`index.html`, 1737 líneas) + un proyecto de Apps Script (tamaño a confirmar tras `clasp clone`); volumen de datos actual (cantidad de pacientes/turnos, y cuántos ya tienen IDs vacíos o inválidos) es parte de lo que la auditoría debe relevar, no un dato de entrada conocido de antemano.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación | Resultado |
|---|---|---|
| I. Stack Fijo | La auditoría no propone ni evalúa cambios de stack (Sheets/Apps Script/GitHub Pages/React se mantienen). | ✅ PASA |
| II. Nueva Implementación Obligatoria | No se despliega ningún cambio de backend en esta tarea (entregable = solo informe); toda recomendación que implique tocar Apps Script debe indicar explícitamente en el informe que su implementación futura requerirá nueva implementación + actualizar URL (FR-010). | ✅ PASA (no aplica todavía; documentado como restricción para trabajo futuro) |
| III. Flush Obligatorio | Es precisamente uno de los puntos que la auditoría debe verificar del lado del backend (FR-006) — no se puede confirmar sin acceso al código vía clasp. | ✅ PASA (objeto de la auditoría, no una violación) |
| IV. Autenticación Compartida Estable | No se toca el esquema de login; la auditoría solo lo usa para probar el flujo end-to-end si es necesario. | ✅ PASA |
| V. Simplicidad Sobre Expansión | Se introduce una única pieza de tooling nueva: `clasp` (vía `npx`, sin dependencia persistente) y una carpeta de código backend clonado para lectura. Justificado explícitamente por el usuario en la clarificación de la spec (acceso "vía clasp"). No se agregan features, dependencias de producto ni cambios visuales. | ✅ PASA (ver Complexity Tracking para la justificación formal) |

**Resultado global**: Sin violaciones sin justificar. Un ítem de complejidad (tooling `clasp`) queda documentado en Complexity Tracking porque agrega superficie nueva al repo (aunque sea solo de diagnóstico), tal como pide el Principio V ante cualquier adición no trivial.

**Re-chequeo post-Fase 1**: Los artefactos de diseño (`data-model.md`, `contracts/apps-script-api.md`, `quickstart.md`) no introducen entidades de producto, dependencias ni cambios de alcance nuevos respecto de lo evaluado arriba — documentan el esquema y contrato ya existentes, más el protocolo de datos de prueba etiquetados sobre producción (Decisión 3 de `research.md`), que ya estaba contemplado en Constraints. Constitution Check se mantiene ✅ sin cambios.

## Project Structure

### Documentation (this feature)

```text
specs/001-audit-pacientes-turnos-sync/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── apps-script-api.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
# Estructura actual del repo (antes de esta auditoría)
index.html               # Frontend completo: React (CDN) + lógica de datos + llamadas a Apps Script
.specify/                # Tooling de Spec Kit (specs, memoria de constitución, templates)
specs/                   # Specs de features (esta auditoría incluida)

# Estructura añadida SOLO para esta auditoría (tooling de diagnóstico, no una feature de producto)
backend-appsscript/       # Código del proyecto Apps Script, obtenido vía `clasp clone` (read-only para la auditoría)
├── .clasp.json           # Config de clasp (scriptId del proyecto vinculado a la Web App)
├── appsscript.json        # Manifest del proyecto Apps Script
└── Code.gs (u otros .gs)  # Código server-side real a auditar (nombre exacto TBD tras clonar)
```

**Structure Decision**: No se reestructura el frontend existente (`index.html` se mantiene como está — no es una tarea de refactor). Se agrega únicamente `backend-appsscript/` en la raíz del repo, como carpeta de solo-lectura para esta auditoría, poblada vía `clasp clone` (Decisión 1 en `research.md`). Esto le da a la auditoría acceso a rutas y números de línea reales del backend para citarlos en el informe de hallazgos, sin tocar el frontend ni introducir un build step nuevo.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Se agrega `clasp` (vía `npx`, sin instalación global) y una carpeta `backend-appsscript/` al repo | El backend de Apps Script no está versionado en ningún lado accesible; sin verlo, la auditoría no puede confirmar la causa raíz de la generación de IDs ni el uso de `flush()` (FR-006), que es el corazón del bug reportado | Copiar/pegar el código manualmente desde el editor de script.google.com fue considerado y rechazado (ver `research.md`, Decisión 1): no permite citar líneas exactas de forma confiable, no es reproducible en auditorías futuras, y es más propenso a errores de transcripción que clasp |
