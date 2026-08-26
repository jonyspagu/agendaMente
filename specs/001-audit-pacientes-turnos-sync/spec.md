# Feature Specification: Auditoría de Estabilidad — Sincronización Pacientes-Turnos

**Feature Branch**: `001-audit-pacientes-turnos-sync`

**Created**: 2026-08-26

**Status**: Draft

**Input**: User description: "Necesito una revisión completa y auditoría de estabilidad de AgendaMente antes de agregar cualquier feature nueva. El proyecto ya está en producción con una usuaria real (Lupita) y encontró un bug crítico: al cargar una consulta/turno nuevo, el paciente asociado no se está guardando correctamente en el módulo Pacientes — el resultado son turnos que quedan sin nombre de paciente vinculado, y pacientes que directamente no quedan guardados en el Sheet. Diagnóstico preliminar: en la hoja Turnos los IDs se guardan correctamente (1,2,3,4), pero en la hoja Pacientes la columna ID queda vacía — sospecho que el paciente nuevo no recibe o no guarda un ID al crearse, y por eso el turno no puede vincular el nombre. Quiero que se audite el flujo completo end-to-end: desde que se carga un paciente o se agrega una consulta en el frontend, pasando por las llamadas a Apps Script, hasta la escritura final en el Sheet y la lectura posterior. Objetivo: identificar todos los puntos donde el guardado o la sincronización entre consultas y pacientes puede estar fallando, no solo el síntoma reportado. No agregar features nuevas ni tocar diseño visual — el foco es exclusivamente que lo que ya existe funcione de manera confiable."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Diagnosticar la causa raíz del bug crítico de IDs de paciente (Priority: P1)

Jonatan necesita entender con evidencia concreta por qué, al crear un paciente nuevo y luego un turno para ese paciente, el paciente puede quedar sin ID persistente en la hoja "Pacientes" y el turno puede quedar sin vínculo al nombre del paciente — reproduciendo el problema paso a paso a lo largo de todo el flujo (frontend → Apps Script → Sheet → lectura posterior) y documentando exactamente en qué punto se rompe.

**Why this priority**: Es el bug reportado por la usuaria real (Lupita) en producción. Sin un diagnóstico preciso de la causa raíz, cualquier corrección futura sería un parche a ciegas sobre un síntoma, con riesgo de no resolver el problema real o de introducir uno nuevo.

**Independent Test**: Reproducir (o intentar reproducir de forma controlada) la creación de un paciente nuevo seguida de un turno para ese paciente, registrando en cada paso del flujo si el dato se guardó como se esperaba, hasta identificar el punto exacto donde el ID deja de persistirse o de propagarse.

**Acceptance Scenarios**:

1. **Given** el formulario de alta de paciente, **When** se completa y se guarda un paciente nuevo, **Then** la auditoría registra si la fila correspondiente en la hoja "Pacientes" quedó con la columna ID completa o vacía, y en qué paso del flujo se determinó ese resultado.
2. **Given** un paciente creado durante la reproducción del bug, **When** se intenta crear un turno seleccionando ese paciente, **Then** la auditoría documenta si el turno quedó vinculado correctamente al nombre del paciente al recargar la agenda, y de no ser así, en qué punto del flujo se pierde el vínculo.
3. **Given** el diagnóstico completo del bug crítico, **When** se documenta como hallazgo, **Then** incluye causa raíz identificada (o las hipótesis descartadas y las pendientes de verificar), ubicación exacta en el código, y el comportamiento esperado que debería tener el sistema en ese punto.

---

### User Story 2 - Auditar el flujo end-to-end en busca de otros puntos de falla (Priority: P2)

Jonatan necesita un relevamiento completo del camino que sigue un dato desde que se ingresa en el frontend (alta de paciente o de turno) hasta que queda escrito en el Sheet y disponible en una lectura posterior, para encontrar y documentar cualquier otro punto donde el guardado o la sincronización entre "Turnos" y "Pacientes" pueda fallar, más allá del síntoma ya reportado.

**Why this priority**: El síntoma reportado (ID de paciente vacío) puede ser una manifestación de un problema más general de sincronización. Corregir solo el síntoma sin auditar el resto del flujo deja la puerta abierta a variantes del mismo bug (por ejemplo, turnos con datos inconsistentes, pacientes duplicados, o falta de actualización tras escritura).

**Independent Test**: Recorrer manualmente cada función involucrada en el flujo de creación/lectura de pacientes y turnos (frontend → llamada a Apps Script → escritura en Sheet → recarga de datos) y producir un listado de hallazgos, cada uno con ubicación, severidad y causa raíz, independientemente de si ya se corrigió el síntoma original.

**Acceptance Scenarios**:

1. **Given** el código fuente del frontend y del backend de Apps Script (obtenido vía clasp para esta auditoría), **When** se audita el flujo de creación de paciente y de turno, **Then** se produce un listado de todos los puntos de fragilidad encontrados, incluyendo al menos: generación/persistencia de IDs, validación de datos antes de guardar, y actualización del estado del frontend tras guardar.
2. **Given** un turno cuyo ID de paciente no es un número válido, **When** se recarga el listado completo de turnos, **Then** la auditoría documenta si el sistema lo detecta y señala, o si lo muestra silenciosamente como si tuviera un paciente válido.
3. **Given** un hallazgo de auditoría documentado, **When** se revisa su severidad, **Then** queda claro si afecta a la integridad de datos (crítico), a la experiencia de uso (medio) o es una mejora de robustez menor (bajo).

---

### User Story 3 - Verificar y remediar datos ya afectados en producción (Priority: P3)

Jonatan necesita saber si, a raíz del bug ya ocurrido, existen hoy en la hoja de producción pacientes con ID vacío o turnos con una referencia de paciente inválida, y contar con una forma clara de identificarlos y corregirlos sin duplicar información ni perder historial clínico.

**Why this priority**: Aunque se corrija el bug hacia adelante, los datos ya dañados en producción (con una usuaria real usando el sistema) pueden seguir causando turnos sin nombre visible hasta que se remedien explícitamente.

**Independent Test**: Revisar el estado actual de las hojas "Pacientes" y "Turnos" en producción, listar cualquier fila de paciente con ID vacío y cualquier turno con `pacienteId` inválido o sin correspondencia, y proponer una acción de remediación para cada caso.

**Acceptance Scenarios**:

1. **Given** el estado actual de la hoja "Pacientes" en producción, **When** se revisan todas las filas, **Then** se listan explícitamente las que tienen ID vacío o inválido, si existen.
2. **Given** el estado actual de la hoja "Turnos" en producción, **When** se revisan todas las filas, **Then** se listan explícitamente las que referencian un `pacienteId` que no existe en "Pacientes".
3. **Given** una fila de paciente o turno identificada como afectada, **When** se define su remediación, **Then** la acción propuesta no genera pérdida de historial clínico ni duplicación de pacientes.

---

### Edge Cases

- ¿Qué pasa si dos turnos se crean casi al mismo tiempo para un paciente recién creado, antes de que el ID del paciente termine de persistirse (condición de carrera)?
- ¿Qué pasa si la escritura de un paciente nuevo en el Sheet se interrumpe a medias (la fila queda creada pero sin todas sus columnas, incluyendo el ID)?
- ¿Qué pasa si el frontend muestra un paciente como "creado" en su estado local, pero ese paciente nunca llegó a persistirse en el Sheet (por ejemplo, por un error de red no manejado)?
- ¿Qué pasa si ya existen en producción pacientes con ID vacío antes de aplicar cualquier corrección? ¿Cómo se distinguen de pacientes nuevos legítimos durante la remediación?
- ¿Qué pasa si se recarga el listado completo de datos (pacientes, turnos, cobros) y una sola fila de paciente tiene un dato inválido — se debe bloquear la carga completa o solo omitir/señalar esa fila?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: La auditoría MUST determinar, con evidencia reproducida paso a paso, en qué punto exacto del flujo de creación de paciente el identificador único deja de asignarse o de persistirse en la hoja "Pacientes".
- **FR-002**: La auditoría MUST determinar si, y en qué condiciones, un turno puede quedar guardado referenciando un paciente cuyo ID no está confirmado como persistido en la hoja "Pacientes".
- **FR-003**: La auditoría MUST determinar si el sistema detecta o no cualquier turno cuyo identificador de paciente no sea un valor numérico válido, y documentar qué ocurre hoy en ese caso (guardado silencioso, error, u otro comportamiento).
- **FR-004**: La auditoría MUST evaluar si, al confirmar la creación de un paciente, el frontend verifica que el identificador devuelto por el backend corresponde a un registro efectivamente persistido, o si asume éxito de forma optimista sin esa confirmación.
- **FR-005**: La auditoría MUST evaluar si el sistema aplica el mismo nivel de validación de integridad de datos (identificadores de pacientes) tanto al crear un paciente como al recargar el listado completo de datos, señalando cualquier asimetría donde un dato inválido pase inadvertido en un flujo mientras bloquea otro.
- **FR-006**: La auditoría MUST verificar, del lado del backend (Apps Script, accedido vía clasp), si toda escritura de datos nuevos (paciente o turno) completa su persistencia —incluido el identificador asignado y el uso de `flush()`— antes de que cualquier lectura posterior dentro del mismo flujo dependa de ese dato.
- **FR-007**: La auditoría MUST identificar y documentar, con ubicación y severidad, todos los puntos del flujo end-to-end (ingreso en frontend, llamada a backend, escritura en la hoja, lectura posterior) donde el guardado o la sincronización entre turnos y pacientes puede fallar — no únicamente el síntoma originalmente reportado.
- **FR-008**: La auditoría MUST verificar el estado actual de los datos en el Sheet de producción para detectar pacientes con identificador vacío o inválido y turnos con referencia de paciente inválida ya existentes, documentando cada caso encontrado, sin modificar esos datos como parte de esta tarea.
- **FR-009**: El entregable de esta auditoría MUST ser un informe escrito con los hallazgos priorizados (causa raíz, ubicación, severidad) y una recomendación de remediación para cada uno; la implementación y el despliegue de las correcciones quedan fuera de alcance de esta tarea y se planificarán como trabajo posterior.
- **FR-010**: Cualquier recomendación de corrección que implique cambios al backend de Apps Script MUST indicar explícitamente, dentro del informe, que su implementación futura requerirá una nueva implementación (no basta con guardar el código) y la actualización de la URL en el frontend.
- **FR-011**: Esta auditoría MUST limitarse a diagnosticar la confiabilidad del guardado y la sincronización existentes: NO debe proponer ni introducir features nuevas, cambios de diseño visual, ni cambios de stack o de esquema de autenticación.
- **FR-012**: Toda verificación realizada como parte de esta auditoría MUST llevarse a cabo sin alterar los datos reales de producción (el Sheet que usa Lupita), dado que no existe un entorno de prueba separado.

### Key Entities *(include if feature involves data)*

- **Paciente**: registro en la hoja "Pacientes" con un identificador único, nombre y demás datos de contacto/clínicos. Debe recibir y conservar un ID persistente en el momento de su creación; es la entidad referenciada por los turnos.
- **Turno/Consulta**: registro en la hoja "Turnos" vinculado a un Paciente mediante su identificador. Su utilidad depende de que ese identificador exista, sea válido y esté efectivamente persistido en el momento de la vinculación.
- **Hallazgo de auditoría**: cada punto de fragilidad identificado en el flujo end-to-end de guardado/sincronización, con su ubicación, severidad (crítico/medio/bajo) y causa raíz documentadas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El informe de auditoría documenta, con evidencia reproducida, el punto exacto del flujo donde el identificador de paciente deja de persistirse — cerrando el diagnóstico del bug crítico reportado con causa raíz identificada (o hipótesis explícitamente descartadas si no se puede confirmar con certeza).
- **SC-002**: El informe de auditoría identifica y prioriza el 100% de los puntos de falla encontrados en el flujo end-to-end (frontend, backend, Sheet, lectura posterior), cada uno con ubicación y severidad documentadas, no solo el síntoma originalmente reportado.
- **SC-003**: Todos los registros existentes en el Sheet de producción con identificadores faltantes o inválidos (pacientes o turnos) quedan identificados, listados en el informe, y con una acción de remediación propuesta — sin que la auditoría misma modifique o pierda datos de producción.
- **SC-004**: Cada hallazgo del informe incluye una recomendación de corrección lo suficientemente concreta (ubicación en el código, comportamiento esperado) como para que una tarea posterior pueda implementarla sin re-investigar el problema desde cero.
- **SC-005**: El informe deja explícito, para cada hallazgo, si su corrección requiere cambios en el backend de Apps Script (y por lo tanto una nueva implementación) o solo en el frontend.

## Assumptions

- El stack tecnológico (Google Sheets, Google Apps Script, GitHub Pages, React) se mantiene sin cambios; esta auditoría no propone ni evalúa una migración de stack.
- El esquema de autenticación compartida actual sigue vigente y no se modifica como parte de esta auditoría.
- Toda corrección de backend seguirá el flujo obligatorio de nueva implementación en Apps Script y usará `flush()` tras cada escritura, conforme a las prácticas ya establecidas para este proyecto.
- No se agregan features nuevas ni se modifica el diseño visual como parte de esta tarea: el foco es exclusivamente la confiabilidad de lo ya existente.
- El entregable de esta tarea es únicamente el informe de auditoría (hallazgos priorizados con causa raíz, ubicación y recomendación). La implementación y el despliegue de las correcciones —incluida la del bug crítico reportado— quedan fuera de alcance y se planificarán como trabajo posterior a partir de este informe.
- El código fuente completo del proyecto de Apps Script vinculado a este frontend no está versionado en este repositorio (solo se encontró un archivo `index.html` con el frontend). Se traerá ese código al entorno local mediante `clasp` como prerequisito para completar la auditoría del lado del servidor (generación de IDs, uso de `flush()`, lógica de escritura en "Pacientes" y "Turnos").
- No existe un Sheet o entorno de prueba separado del de producción: toda verificación de esta auditoría se realiza directamente sobre el Sheet que usa Lupita. Cualquier prueba que implique crear o modificar datos debe hacerse con cuidado de no interferir con su uso real, y idealmente coordinando el horario con ella; los datos de prueba creados durante la auditoría deben poder identificarse y limpiarse después.
