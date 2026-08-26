# Data Model: Auditoría de Estabilidad — Sincronización Pacientes-Turnos

Esta auditoría no crea entidades de producto nuevas. Documenta el esquema **ya existente** (tal como lo consume el frontend, confirmado en `index.html:1310-1331`) y define el único artefacto nuevo que produce esta tarea: el **Hallazgo de auditoría**.

## Paciente (hoja "Pacientes")

Fuente: `CAMPOS_PACIENTE` en `index.html:1310-1329`.

| Campo | Tipo esperado | Notas |
|---|---|---|
| `id` | Number, requerido, único | **Punto crítico bajo auditoría**: debe asignarse y persistir en el momento de creación. `normalizarPaciente` (línea 1344) fuerza `Number(base.id)`; si el Sheet lo tiene vacío, esto da `NaN`. |
| `nombre`, `apellido` | String | Identificación del paciente. |
| `precio` | Number | Forzado con `Number(base.precio) \|\| 0` (línea 1344). |
| `telefono`, `notas` | String | |
| `desde` | String (mes/año) | Fecha de alta, generada en frontend (línea 1535), no en el backend. |
| `ultimoAumento` | String (fecha ISO) | |
| `frecuenciaDias` | Number | Default 7 al crear (línea 1544). |
| `mesesAumento` | Number | Default 6 al crear (línea 1545). |
| `historia` | String (JSON serializado) | Lista de entradas `{fecha, texto}`; default `"[]"`. |
| `contactoReferencia`, `parentescoReferencia`, `telefonoReferencia` | String | Con lógica de compatibilidad hacia atrás en `normalizarPaciente` (líneas 1334-1343) si solo viene `contactoReferencia` con formato `"parentesco:telefono"`. |
| `consentimientoFirmado` | String ("SI"/"NO") | Default `"NO"`. |
| `fechaConsentimiento`, `tipoPago`, `linkConsentimiento` | String | `tipoPago` default `"sesion"`. |

**Relación**: es la entidad referenciada por Turno y Cobro vía `pacienteId`.

## Turno/Consulta (hoja "Turnos")

Fuente: `CAMPOS_TURNO` en `index.html:1330`.

| Campo | Tipo esperado | Notas |
|---|---|---|
| `id` | Number, requerido, único | Generado por el backend al crear (`Turnos`/`create`); el diagnóstico preliminar indica que este ID sí se persiste correctamente hoy (síntoma reportado por el usuario). |
| `pacienteId` | Number, requerido | **Punto crítico bajo auditoría**: `normalizarTurno` (línea 1348) hace `Number(base.pacienteId)` **sin** validar `Number.isFinite`, a diferencia de `Paciente.id`. Un turno con `pacienteId` vacío/no numérico se normaliza a `NaN` sin que la app lo detecte al releer datos existentes (solo se valida en el formulario de creación). |
| `fecha`, `hora` | String | |
| `estado` | String enum (`"agendado"`, `"realizado"`, otros) | |

**Relación**: depende de que `pacienteId` exista, sea numérico y corresponda a una fila real y persistida en Paciente para poder resolver el nombre a mostrar.

## Cobro (hoja "Cobros")

Fuente: `CAMPOS_COBRO` en `index.html:1331`. Mismo patrón de riesgo que Turno: `pacienteId` se fuerza a `Number` (línea 1352) sin validar finitud.

## Hallazgo de auditoría *(artefacto nuevo, producido por esta tarea)*

No es una entidad del producto — es la unidad de contenido del informe que entrega esta auditoría (spec Key Entities, FR-007, FR-009).

| Campo | Descripción |
|---|---|
| `id` | Identificador secuencial del hallazgo dentro del informe (H1, H2, …). |
| `titulo` | Descripción breve del problema. |
| `severidad` | `crítico` (afecta integridad de datos) \| `medio` (afecta experiencia de uso) \| `bajo` (mejora de robustez). |
| `ubicacion` | Archivo:línea exacto (frontend en `index.html`, backend en `backend-appsscript/...` una vez clonado). |
| `causa_raiz` | Explicación técnica de por qué ocurre, o hipótesis explícitamente marcadas como no confirmadas. |
| `evidencia` | Cómo se reprodujo o confirmó (análisis estático, prueba controlada en producción con dato etiquetado, o ambas). |
| `recomendacion` | Acción de corrección concreta sugerida, sin implementarla (FR-009, FR-010). |
| `requiere_backend` | Booleano — si la corrección implica tocar Apps Script (y por lo tanto requerirá nueva implementación, Principio II). |

## State / flujo relevante (no hay máquina de estados formal, pero sí una secuencia crítica)

1. Frontend arma `nuevo` (sin `id`) → `apiCall("Pacientes", "create", {data: nuevo})`.
2. Backend (a auditar) debería: asignar `id`, escribir la fila completa (incluido `id`) en "Pacientes", hacer `flush()`, y devolver `{id, pacientes: [...]}` con la lista actualizada.
3. Frontend recibe `res`, calcula `nuevoId = Number(res.id)`, y hace merge optimista contra `res.pacientes` (`index.html:1556-1562`) — **sin verificar que `nuevoId` sea un número válido antes de aceptarlo**.
4. Al crear un turno, el usuario elige un paciente del estado local (`pacientes` en memoria, no releído del servidor) vía `PacienteSearchSelect`.
5. `apiCall("Turnos", "create", {data: {pacienteId, ...}})` — si `pacienteId` viene de un paciente con ID inválido en memoria (paso 3), el turno se guarda con esa referencia rota.
6. Cualquier recarga completa (`aplicarDataset`) después de esto bloquea toda la vista si detecta un `Paciente.id` no numérico — pero no bloquea ni señala un `Turno.pacienteId` no numérico (asimetría ya documentada en FR-005/FR-003).
