# Informe de Auditoría de Estabilidad: Sincronización Pacientes-Turnos

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Estado**: Foundational + US1 completos y cerrados (causa raíz confirmada). US2 y US3 pendientes, fuera de alcance de esta ejecución.

**Alcance de este documento**: informe de hallazgos. No se implementó ni desplegó ninguna corrección — conforme a FR-009/FR-011 de la spec.

## Resumen Ejecutivo

*(versión parcial — se completa del todo al cerrar Polish, Phase 6, con los hallazgos de US2+US3 todavía pendientes)*

**US1 cerrado.** Causa raíz del bug crítico reportado: **confirmada**. La hoja "Pacientes" tiene el header de la columna id escrito como `Id` (con mayúscula) en vez de `id`; el backend (`Código.js:138`) compara ese header contra el literal `"id"` con `===` estricto, sin normalizar mayúsculas ni espacios — por eso nunca logra escribir el ID en esa columna, y la fila del paciente queda con id vacío. Como el backend además filtra (al leer) cualquier fila con id vacío, ese paciente "desaparece" de la app en la próxima recarga, aunque sus datos sigan físicamente en el Sheet — dejando cualquier turno creado para él sin nombre visible. En "Turnos" el header sí es `id` exacto, por eso esos IDs siempre se guardaron bien. **Fix recomendado más simple: renombrar la celda A1 de "Pacientes" a `id` (todo minúscula)** — no requiere tocar código ni desplegar nada nuevo (ver Hallazgo H1). Ningún dato de producción fue modificado durante esta auditoría.

## Referencia interna — Estructura del backend (T006)

`backend-appsscript/Código.js` (165 líneas, único archivo `.gs` del proyecto):

| Función | Rol |
|---|---|
| `doGet(e)` | Login/lectura: valida `clave`, devuelve `getAllData()` completo |
| `doPost(e)` | Router de `create`/`update`/`delete` para `sheet` recibido |
| `getAllData()` | Arma `{pacientes, turnos, cobros}` vía `sheetToObjects` sobre cada hoja |
| `sheetToObjects(sh)` | Lee headers de fila 1 + todas las filas, **filtra filas donde `row[0]` (columna id) sea `""` o `null`** (línea 105) |
| `getNextId(sh)` | `max(Number(col0 de todas las filas)) + 1` — robusto ante ids vacíos (`Number("") === 0`, no rompe el cálculo) |
| `buildRow(sh, id, data)` | Arma la fila a escribir leyendo los headers reales de la hoja; **compara cada header contra el string `"id"` con `===` estricto (sin `.toLowerCase()`/`.trim()`)** (línea 138) |
| `updateRowById` / `deleteRowById` | Buscan la fila por `id` con `String(values[i][0]) === String(id)` |

No hay funciones `create`/`update`/`delete` separadas por hoja: es un único router genérico que arma filas dinámicamente según los headers reales de cada hoja. Esto es relevante para US2 (T015-T016), pero ya explica por qué no hay "una función de Pacientes" y "una función de Turnos" distintas — es la misma lógica para las tres hojas.

## Hallazgo H1 — Bug crítico: ID de paciente queda vacío al crear (T007, T008, T012)

- **Severidad**: crítico
- **Ubicación**: `backend-appsscript/Código.js:135-142` (`buildRow`) + `backend-appsscript/Código.js:100-111` (`sheetToObjects`), en interacción con `index.html:1556-1562` (`agregarPaciente`)
- **Estado de confirmación**: **CONFIRMADO**. Causa raíz identificada vía análisis estático del código real (T007) y verificada directamente por Jonatan sobre el Sheet de producción, sin necesidad de crear ni borrar ningún dato.

### Causa raíz (cadena completa)

1. **`getNextId` funciona bien** (`Código.js:122-130`): calcula el próximo ID como `max(Number(id de cada fila)) + 1`, recorriendo la columna 0. Es tolerante a filas con `id` vacío (`Number("")` da `0`, no `NaN`, así que no rompe el cálculo del máximo). **Esto descarta la hipótesis de que el ID no se genera** — sí se genera correctamente.

2. **`buildRow` es donde se rompe** (`Código.js:135-142`):
   ```js
   function buildRow(sh, id, data) {
     const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
     return headers.map((h) => {
       if (h === "id") return id;
       if (Object.prototype.hasOwnProperty.call(data, h)) return data[h];
       return "";
     });
   }
   ```
   La comparación `h === "id"` es **estrictamente sensible a mayúsculas/minúsculas y a espacios**, sin ningún `.trim()` ni `.toLowerCase()`. Si el texto real de la celda A1 de la hoja "Pacientes" no es exactamente el string `"id"` (por ejemplo `"Id"`, `"ID"`, `" id"`, `"id "`, o cualquier variante), esta condición nunca se cumple. Como `data` (el objeto que manda el frontend en `agregarPaciente`, `index.html:1536-1554`) tampoco tiene una clave `id` propia, cae en el `return ""` — **la fila se escribe con la columna id vacía**, exactamente el síntoma reportado.
   - Esto es coherente con que en "Turnos" los IDs sí se guarden bien (`1,2,3,4`): bastaría con que el header de la columna id en "Turnos" sea literalmente `"id"` mientras que en "Pacientes" tenga alguna variación — algo perfectamente posible si se tipearon a mano en momentos distintos.
   - Es además coherente con que el propio frontend ya "sospechaba" de este problema: el mensaje de error en `index.html:1391-1393` dice textualmente *"Revisá que la primera columna de la hoja Pacientes se llame exactamente 'id'"* — quien escribió esa validación ya intuía este modo de falla.

3. **`SpreadsheetApp.flush()` SÍ está presente y en el lugar correcto** (`Código.js:57`, inmediatamente después de `appendRow` y antes de `getAllData()`). **Esto descarta la hipótesis de "falta de flush"** (Principio III de la constitución) como causa de este bug — no es un problema de timing/condición de carrera, es un problema de contenido (el header no matchea).

4. **`sheetToObjects` amplifica el problema al leer** (`Código.js:100-111`, línea 105): `filter((row) => row[0] !== "" && row[0] !== null)`. Como la fila del paciente recién creado quedó con `row[0]` (columna id) en `""`, **esta fila queda excluida de `getAllData().pacientes`** — es decir, el backend responde `ok: true, id: <número válido>`, pero la lista `pacientes` que devuelve en la misma respuesta **no incluye a este paciente**. El dato de la persona (nombre, teléfono, etc.) sí quedó físicamente en la fila del Sheet — pero la app nunca vuelve a "verlo" porque cualquier lectura futura (recarga completa incluida) también lo filtra.

5. **El frontend no detecta la inconsistencia y la enmascara** (`index.html:1555-1562`):
   ```js
   const res = await apiCall("Pacientes", "create", { data: nuevo });
   const nuevoId = Number(res.id); // válido, ej. 5 — el backend SÍ devuelve un id numérico correcto
   setPacientes((prev) => {
     const desdeServidor = (res.pacientes || []).map(normalizarPaciente).filter((p) => Number.isFinite(p.id));
     const lista = desdeServidor.length >= prev.length ? desdeServidor : prev;
     if (lista.some((p) => p.id === nuevoId)) return lista;
     return [...lista, { ...nuevo, id: nuevoId, precio: Number(nuevo.precio) || 0 }]; // se agrega igual, sin verificar
   });
   ```
   Como `res.id` (paso 2 del router, `Código.js:60`) SÍ es un número válido (se calculó bien en `getNextId`, independientemente de que no se haya podido escribir en la celda), `nuevoId` no es `NaN` — pasa la comprobación optimista sin alertar a nadie. El paciente aparece "creado" en la UI, con un ID que en los hechos nunca quedó en el Sheet. Cualquier turno creado después para este paciente queda referenciando un `pacienteId` que la próxima recarga completa jamás podrá resolver a un nombre (porque `sheetToObjects` sigue filtrando esa fila).

### Por qué el turno "sí" se guarda con ID correcto pero sin vínculo

El ID del turno (`Turnos.id`) se genera y persiste de forma independiente y correcta (mismo `getNextId`/`buildRow`, pero sobre la hoja "Turnos" — que se hipotetiza tiene el header `"id"` bien escrito). El problema no está en el turno: está en que el `pacienteId` que el turno referencia apunta a una fila de "Pacientes" que quedó con id vacío y por lo tanto invisible para la app — el turno en sí está perfectamente guardado, pero no hay ningún paciente con ese ID que la app pueda encontrar para mostrar el nombre.

### Confirmación (verificado directamente por Jonatan sobre el Sheet de producción)

| Hoja | Celda A1 (header de la columna id) |
|---|---|
| "Pacientes" | `Id` (con mayúscula inicial) |
| "Turnos" | `id` (todo minúscula) |

Esto confirma exactamente la hipótesis: `h === "id"` en `buildRow` (`Código.js:138`) compara contra el string literal `"id"` sin normalizar mayúsculas/espacios. Como el header real de "Pacientes" es `"Id"` (con I mayúscula), la condición `h === "id"` da `false` para esa columna en cada creación de paciente, y el bloque cae en `return ""` (línea 140) — escribiendo la columna id vacía en cada paciente nuevo. En "Turnos", el header sí es `"id"` exacto, por eso ese ID siempre se escribió bien, tal como reportó el usuario originalmente.

**No hizo falta crear ni borrar ningún paciente/turno de prueba en producción** para llegar a esta confirmación (T009-T011 y T013 no se ejecutaron — ver Nota de alcance).

### Recomendación (no implementada en esta tarea, FR-009)

Hay dos correcciones independientes, ambas recomendadas (una no reemplaza a la otra: la primera resuelve el síntoma ya, la segunda evita que vuelva a pasar con cualquier otra hoja/columna en el futuro):

1. **Fix inmediato de datos, sin tocar código**: renombrar la celda A1 de la hoja "Pacientes" de `Id` a `id` (todo minúscula), igual que en "Turnos". Esto por sí solo resuelve el síntoma reportado — no requiere nueva implementación de Apps Script ni cambios de frontend. **`requiere_backend`: no.**
2. **Fix de robustez en el código** (para que este tipo de error de tipeo en un header no vuelva a causar pérdida silenciosa de datos): en `backend-appsscript/Código.js:138`, cambiar `if (h === "id")` por una comparación tolerante a mayúsculas/espacios, ej. `if (String(h).trim().toLowerCase() === "id")` — el mismo criterio que el frontend ya aplica al leer datos en `leerCampo`/`normalizarClaves` (`index.html:1296-1309`), pero que hoy falta del lado de la escritura en el backend. **`requiere_backend`: sí.**
   - **Estado**: ✅ aplicado en `backend-appsscript/Código.js:138` y ✅ desplegado — el usuario creó una nueva implementación en Apps Script y la URL nueva quedó actualizada en `index.html:1284` (`API_URL`), conforme al Principio II de la constitución. **Pendiente**: probar el flujo end-to-end en producción (crear paciente + turno de prueba) para confirmar que el fix resuelve el síntoma sin regresiones, antes de dar por cerrada esta corrección.

### Dato ya afectado a tener en cuenta

Además del bug hacia adelante, es esperable que **ya existan hoy en producción** filas de "Pacientes" con la columna id vacía (cualquier paciente creado mientras el header decía `Id`) y turnos que referencian esos pacientes sin poder resolver su nombre. Ese inventario y su remediación son el objeto de **US3 (T021-T024)**, todavía no ejecutada — este hallazgo H1 se limita a la causa raíz hacia adelante.

## Hallazgo H2 — Bug crítico: `pacienteId` no se guarda en Turnos por mismatch de header (descubierto al validar el fix de H1)

- **Severidad**: crítico
- **Ubicación**: `backend-appsscript/Código.js:139` (`buildRow`, rama genérica de campos) y `backend-appsscript/Código.js:144-156` (`updateRowById`, mismo defecto de diseño)
- **Estado**: **CONFIRMADO** — headers reales provistos por el usuario: Turnos = `Id, pacienteid, fecha, hora, estado` (nota: `pacienteid` sin "I" mayúscula) vs. lo que el frontend siempre envía, `pacienteId` (`index.html:1474`, `1330`)

### Causa raíz

El fix aplicado para H1 (línea 138) normalizó **solo** la comparación especial del header `id`. La línea 139, que copia cualquier otro campo, sigue haciendo `Object.prototype.hasOwnProperty.call(data, h)` — una búsqueda de propiedad exacta y sensible a mayúsculas. Como el header real es `pacienteid` y el frontend manda la clave `pacienteId`, la condición nunca matchea y el valor se escribe como `""`. El turno igual se crea (fecha/hora/estado sí matchean), pero con `pacienteid` vacío — de ahí "SIN PACIENTE ASIGNADO" en la agenda tras `normalizarTurno` convertir ese vacío en `NaN`.

`updateRowById` (usado en `Turnos`/`update`, `Pacientes`/`update`, etc.) tiene el mismo defecto de fondo con otra forma: `headers.indexOf(key)` sobre `key` en camelCase contra headers reales — por eso también se detectó, en paralelo, que **`ultimoAumento` (frontend) vs. `ultimoaumento` (header real de "Pacientes") nunca se persiste al registrar un aumento de precio** (`marcarAumento`/`aplicarAumento`) — un bug silencioso independiente del síntoma original, ya presente antes de esta auditoría.

### Recomendación (no implementada — pendiente de decisión del usuario)

Generalizar a ambas funciones el mismo criterio de normalización usado para `id` en H1 (comparar `String(h).trim().toLowerCase()` contra `String(key).trim().toLowerCase()` en vez de una igualdad exacta), en:
- `buildRow` línea 139 (creación) — resuelve el bug de `pacienteId` en Turnos.
- `updateRowById` línea 150 (actualización) — resuelve el bug de `ultimoAumento` en Pacientes y previene cualquier otro caso latente de mismatch de header en actualizaciones.

**`requiere_backend`: sí.** De aplicarse, requiere nueva implementación en Apps Script y, si cambia la URL de despliegue, actualizarla en `index.html:1284` (Principio II de la constitución).

**Nota**: no se revisaron los headers reales de "Cobros" (no fueron provistos) — el mismo patrón de riesgo podría aplicar ahí también (`pacienteId`).

## Nota de alcance — T002, T009-T011, T013 no fueron necesarias

Las tareas T002 (confirmar acceso de edición al Sheet), T009-T011 (crear paciente/turno de prueba en producción) y T013 (limpiar datos de prueba) **no se ejecutaron, y no hizo falta ejecutarlas**. La causa raíz de H1 quedó confirmada con una vía de menor riesgo: Jonatan verificó personalmente el texto exacto de las celdas A1 de "Pacientes" y "Turnos" (sin necesidad de que un agente navegue el Sheet de producción con historia clínica real, ni de crear/borrar datos de prueba), lo cual coincidió exactamente con la hipótesis levantada por análisis estático del código. Esto cierra US1 sin haber tocado en ningún momento los datos reales de producción.

Se detectó además, como observación aparte (fuera del alcance formal de esta auditoría — no es un hallazgo de sincronización Pacientes-Turnos): `Código.js:29` tiene la contraseña de acceso compartida (`CLAVE_ACCESO`) hardcodeada en texto plano en el archivo fuente. No se propone acción al respecto en este informe (Principio IV: no se toca el esquema de autenticación sin pedido explícito) — se deja mencionado únicamente para que quede registrado.
