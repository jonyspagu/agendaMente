<!--
Sync Impact Report
- Version change: (unratified template) → 1.0.0
- Rationale for MAJOR: initial ratification — first concrete constitution for this project (template
  placeholders had never been filled in).
- Modified principles: n/a (all five principles newly defined)
- Added sections: Core Principles (I–V), Contexto del Producto, Flujo de Trabajo de Desarrollo (Apps
  Script), Governance
- Removed sections: none
- Templates requiring updates:
  - .specify/templates/plan-template.md — ⚠ pending manual check (verify its Constitution Check
    section references stack-fijo / deploy / flush / auth constraints when relevant)
  - .specify/templates/spec-template.md — ✅ no constitution-specific references to reconcile
  - .specify/templates/tasks-template.md — ✅ no constitution-specific references to reconcile
- Follow-up TODOs: none — all placeholders resolved from user-supplied input.
-->

# AgendaMente Constitution

## Core Principles

### I. Stack Fijo (NON-NEGOCIABLE)

El stack tecnológico de AgendaMente es: Google Sheets como base de datos, Google Apps Script como
backend, GitHub Pages como hosting, y React en el frontend. Este stack es una decisión ya tomada,
no un tema abierto a discusión en el trabajo diario.

No se debe proponer ni evaluar migraciones de stack (por ejemplo, a Supabase u otra base de datos/
backend) salvo que el usuario lo pida explícitamente en esa conversación. Una migración de stack es
una decisión de producto futura, no algo a resolver como efecto colateral de una tarea.

**Rationale**: El proyecto está en etapa de validación con un solo usuario real. Reabrir la decisión
de stack en cada tarea consume tiempo y foco que hoy están mejor invertidos en que lo existente
funcione bien.

### II. Nueva Implementación Obligatoria en Apps Script (NON-NEGOCIABLE)

Google Apps Script congela versiones: guardar el código en el editor NO actualiza el endpoint que
usa el frontend. Cualquier cambio al backend (Code.gs u otro archivo server-side) requiere crear una
**Nueva Implementación** desde el editor de Apps Script (Implementar → Nueva implementación). Esto
genera una URL de despliegue nueva, que debe reemplazar la URL anterior en el frontend.

Nunca se debe asumir que un cambio de backend ya está "en producción" solo porque el archivo fue
guardado o commiteado. Toda tarea que toque Apps Script debe terminar verificando explícitamente:
(a) que se creó la nueva implementación, y (b) que la URL nueva quedó actualizada en el frontend.

**Rationale**: Este es el error más costoso y menos obvio del stack elegido — un cambio "correcto"
en el código puede no tener ningún efecto visible porque el frontend sigue apuntando a la
implementación vieja.

### III. Flush Obligatorio Tras Escritura (NON-NEGOCIABLE)

Toda función de Apps Script que escriba en el Google Sheet (agregar, editar o eliminar filas) DEBE
llamar a `SpreadsheetApp.flush()` inmediatamente después de la escritura y antes de cualquier lectura
subsiguiente dentro de la misma ejecución o en llamadas cercanas en el tiempo. Sin este flush, una
lectura posterior puede devolver datos desactualizados.

**Rationale**: Apps Script no garantiza que las escrituras al Sheet sean visibles de inmediato para
lecturas posteriores; esto ya causó bugs de datos "viejos" en el pasado.

### IV. Autenticación Compartida Estable

El login vigente usa una contraseña compartida, validada en el backend (Apps Script). Cualquier
feature nueva DEBE seguir funcionando correctamente bajo este esquema de autenticación. No se debe
introducir un esquema de autenticación distinto (usuarios individuales, OAuth, roles, etc.) salvo
que el usuario lo pida explícitamente.

**Rationale**: Con un solo usuario final (Lupita) en etapa de validación, un esquema de auth más
complejo agregaría superficie de mantenimiento sin beneficio real hoy.

### V. Simplicidad Sobre Expansión

AgendaMente está en etapa de validación: un solo usuario (Lupita) probándolo con datos de ejemplo.
No se agrega infraestructura nueva, dependencias nuevas ni features nuevas sin que el usuario
(Jonatan) lo pida explícitamente. Ante una tarea ambigua, la opción por defecto es la que menos
superficie nueva introduce.

La prioridad de producto en esta etapa es que lo que ya existe funcione bien y sea fácil de
mantener — no crecer el alcance.

**Rationale**: Construir features o infraestructura por anticipación, antes de validar con el
usuario real, es el riesgo de desperdicio más alto en esta etapa del proyecto.

## Contexto del Producto

AgendaMente es un CRM web para el consultorio de psicología de Lupita (la novia del desarrollador,
Jonatan). Cubre gestión de pacientes, turnos/agenda, historia clínica, cobros/facturación y
plantillas de mensajes de WhatsApp. Es una aplicación de un único tenant, pensada para el uso diario
de una sola profesional, no un producto multi-cliente.

## Flujo de Trabajo de Desarrollo (Apps Script)

Todo cambio que toque el backend debe seguir esta secuencia, sin excepciones:

1. Editar el código en el proyecto de Apps Script.
2. Confirmar que las escrituras al Sheet incluyan `SpreadsheetApp.flush()` donde corresponda
   (Principio III).
3. Implementar → **Nueva implementación** (Principio II) — guardar el código NO alcanza.
4. Copiar la nueva URL de despliegue.
5. Actualizar esa URL en el frontend (React/GitHub Pages).
6. Probar el flujo afectado end-to-end, incluyendo login (Principio IV), antes de dar la tarea por
   terminada.

## Governance

Esta constitución tiene prioridad sobre cualquier práctica ad-hoc o preferencia implícita al
trabajar en AgendaMente. Ante un conflicto entre una instrucción puntual y esta constitución, se
debe señalar el conflicto explícitamente antes de proceder.

Enmiendas: solo Jonatan (dueño del proyecto) puede modificar esta constitución, y debe hacerlo de
forma explícita (no se infieren cambios de constitución a partir de comentarios de pasada).
Versionado semántico: MAJOR para eliminar o redefinir principios de forma incompatible, MINOR para
agregar principios o secciones nuevas, PATCH para aclaraciones o correcciones de redacción.

Cada tarea que implique cambios de backend en Apps Script debe verificar cumplimiento de los
Principios II y III antes de cerrarse. Cualquier propuesta de agregar infraestructura, dependencias
o features fuera de lo pedido debe señalarse como sugerencia separada, no ejecutarse de forma
implícita (Principio V).

**Version**: 1.0.0 | **Ratified**: 2026-08-26 | **Last Amended**: 2026-08-26
