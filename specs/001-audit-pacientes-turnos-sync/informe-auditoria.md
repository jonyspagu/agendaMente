# Informe de Auditoría de Estabilidad: Sincronización Pacientes-Turnos

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Estado**: Foundational, US1 y US2 completos y cerrados. H1 y H2 confirmados, corregidos, desplegados y **verificados end-to-end en producción**. Remediación de datos ya afectados en producción hecha (adelanto de US3). US2 relevó 6 hallazgos adicionales (H3-H8), sin aplicar fixes (a pedido explícito).

## Remediación de datos afectados en producción (adelanto de US3)

Antes del deploy de H1, cualquier paciente creado quedaba con `id` vacío y por lo tanto **invisible** para la app (`sheetToObjects` filtra filas con id vacío al leer). Se investigó esto con una función temporal de solo lectura agregada a `Código.js` (`debugSinFiltro`, ya removida), desplegada en una implementación separada de solo para este diagnóstico (no afectó nunca la producción real).

**Hallazgo**: la hoja "Pacientes" tenía 2 pacientes reales invisibles, uno de ellos triplicado por intentos repetidos de carga (síntoma clásico de H1: la usuaria no veía el paciente guardarse y reintentaba):

| Paciente real | Filas encontradas | Resolución |
|---|---|---|
| Ayelen Núñez Leal | 3 filas casi idénticas (variaciones de tipeo) | Se conservó 1 (la confirmada por el usuario), se borraron las otras 2 duplicadas |
| Guadalupe Arcuri | 1 fila | Se conservó, sin cambios de contenido |

**Turnos huérfanos** (6 en total, `pacienteid` vacío) — no se pudo reconstruir el vínculo de forma automática (no hay ningún dato compartido entre paciente y turno más allá de fecha/hora, y ninguna fila de paciente registraba un horario preferido). Cruzando manualmente con la usuaria real (Lupita):
- Turnos 1, 2 y 3 (25/08, todos pasados y ambiguos entre los 2 pacientes reales — mismo horario para ambos) → **se borraron**, decisión del usuario, sin intentar forzar un vínculo incierto.
- Turnos 4, 5 y 6 (26, 27 y 28 de agosto, futuros) → **se dejaron sin vincular, intactos**, a la espera de que se asignen manualmente desde la app ahora que ambos pacientes son seleccionables.

**Acciones de remediación aplicadas** (con verificación después de cada una, vía la API de producción):
1. Se asignó `id: 2` a la fila de Ayelen elegida.
2. Se asignó `id: 3` a la fila de Guadalupe.
3. Se borraron las 2 filas duplicadas de Ayelen.
4. Se borraron los turnos 1, 2 y 3.
5. Se borraron el paciente y turno de prueba usados durante todo este proceso de diagnóstico (Pacientes Id 1 "paciente test", Turnos Id 7).

**Estado final verificado en producción**: 2 pacientes reales (Ayelen Id 2, Guadalupe Id 3) y 3 turnos reales (Id 4, 5, 6), sin datos de prueba, sin duplicados, sin residuos.

**Limpieza de herramientas de diagnóstico**: el código temporal (`debugSinFiltro`, `debugAsignarId`, `debugBorrarFila`, `debugColumnaId` + sus ramas en `doPost`) fue removido de `Código.js` (confirmado por diff, idéntico a la versión con solo los fixes de H1/H2) y pusheado. La implementación separada de Apps Script usada para este diagnóstico fue **eliminada** (`clasp undeploy`) — no alcanzaba con sacar el código de HEAD, ya que una implementación queda fija a la versión que tenía al desplegarse; había que borrarla o redesplegarla para que dejara de exponer las acciones de escritura/borrado por número de fila. La implementación de producción (la que usa `index.html`) no fue tocada en ningún momento por este trabajo de limpieza.

**Alcance de este documento**: informe de hallazgos. No se implementó ni desplegó ninguna corrección — conforme a FR-009/FR-011 de la spec.

## Resumen Ejecutivo

*(versión parcial — se completa del todo al cerrar Polish, Phase 6, con los hallazgos de US2+US3 todavía pendientes)*

**US1 cerrado.** Causa raíz del bug crítico reportado: **confirmada**. La hoja "Pacientes" tiene el header de la columna id escrito como `Id` (con mayúscula) en vez de `id`; el backend (`Código.js:138`) compara ese header contra el literal `"id"` con `===` estricto, sin normalizar mayúsculas ni espacios — por eso nunca logra escribir el ID en esa columna, y la fila del paciente queda con id vacío. Como el backend además filtra (al leer) cualquier fila con id vacío, ese paciente "desaparece" de la app en la próxima recarga, aunque sus datos sigan físicamente en el Sheet — dejando cualquier turno creado para él sin nombre visible. En "Turnos" el header sí es `id` exacto, por eso esos IDs siempre se guardaron bien. Se optó por el fix de robustez en el código (`buildRow`/`updateRowById` con comparación de headers normalizada) en vez de solo renombrar la celda, ya que esto además destapó un segundo bug (H2): el mismo tipo de mismatch de header (`pacienteid` vs. `pacienteId`) impedía guardar la referencia al paciente en cada turno nuevo. Ambos hallazgos (H1 y H2) quedaron **confirmados, corregidos, desplegados (nueva implementación + `API_URL` actualizada) y verificados end-to-end**: un paciente y un turno de prueba reales quedan hoy correctamente vinculados y visibles en la agenda. Ningún dato de producción quedó dañado por la auditoría en sí (los datos de prueba usados para verificar quedaron identificados y se removieron).

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

- **Estado**: ✅ aplicado en `backend-appsscript/Código.js` — se agregó un helper `normalizarHeader(h)` (`.trim().toLowerCase()`) reutilizado en `buildRow` (línea ~139, ahora busca la clave de `data` cuyo header normalizado coincida, en vez de `hasOwnProperty` exacto) y en `updateRowById` (los headers se normalizan antes de buscar el índice de columna). ✅ desplegado y ✅ **verificado end-to-end**. Se hizo un test controlado directo contra la API en vivo (payload limpio `{"pacienteId":1,...}`, sin pasar por la UI) que confirmó que `buildRow` escribe `pacienteid` correctamente; se limpió ese dato de prueba de inmediato. Después el usuario creó un turno real desde la UI (Id 7) y, tras refrescar la página, la agenda mostró el nombre del paciente correctamente vinculado. **H2 cerrado.**

### Nota sobre una hipótesis adicional investigada (y descartada) durante el cierre de H2

Se planteó si `sheetToObjects` (lectura, `Código.js:100-111`) también necesitaba normalizar las claves de los objetos que devuelve (ya que expone el header crudo, ej. `"Id"`/`"pacienteid"`, sin convertir a camelCase). Se verificó ejecutando el código real de `index.html` (`leerCampo`/`normalizarClaves`/`normalizarPaciente`/`normalizarTurno`) contra datos reales devueltos por la API: **el frontend ya hace una búsqueda case-insensitive de claves al normalizar** (`index.html:1296-1309`), por lo que ya tolera que el backend devuelva `Id`/`pacienteid` en vez de `id`/`pacienteId`. No hizo falta ningún cambio adicional en `sheetToObjects` ni en el frontend — el síntoma remanente era solo una vista sin refrescar en el navegador, no un bug de código.

**Nota**: no se revisaron los headers reales de "Cobros" (no fueron provistos) — el mismo patrón de riesgo podría aplicar ahí también (`pacienteId`).

## Hallazgos adicionales — resto del flujo end-to-end (US2, T015-T020)

Relevamiento del resto del código (Cobros, Métricas, `localStorage`, y toda función de guardado/lectura restante en `Código.js`/`index.html`) en busca de fragilidades similares a H1/H2. **Solo relevamiento — ningún fix aplicado todavía.**

### H3 — Sin validación de integridad referencial al crear Turnos/Cobros — ✅ RESUELTO

- **Severidad**: medio
- **Ubicación**: `Código.js` `doPost`, bloques `action === "create"` (líneas 53-62) y `"update"` (64-70)
- **Descripción**: en ningún punto de `doPost` se verifica que `data.pacienteId` corresponda a una fila real y existente en "Pacientes" antes de guardar un Turno o un Cobro. Se acepta y persiste cualquier valor recibido tal cual.
- **¿Cubierto por el fix de H1/H2?** **No.** Ese fix resuelve el mismatch de nombres de columna (headers); esto es un gap de validación de datos completamente distinto.
- **Recomendación** (no aplicada): antes de `appendRow`, verificar que `pacienteId` exista en `sheetToObjects(Pacientes)`; si no, devolver `ok:false` en vez de guardar.
- **Estado**: ✅ **corregido, probado en test y desplegado a producción.** Se agregó `pacienteExiste(pacienteId)` y un chequeo previo a la creación de Turnos/Cobros (antes de tomar el lock, para no retenerlo en requests que se van a rechazar). Probado en `backend-appsscript-test/`: crear un turno con `pacienteId: 9999` (inexistente) → `ok:false, "El paciente indicado (id 9999) no existe. No se guardó el turno."`, sin crear ninguna fila; crear con `pacienteId` válido → sigue funcionando normal. Código idéntico entre test y producción confirmado por diff. Desplegado en producción: `AKfycby0AQpAfIDOSFCxM76I6J3PReHqHgdNulvhfNPLyGnMWTUrl77jijb-lbic2sah-8Ks7w`, `API_URL` actualizada en `index.html:1284`, verificado que lee bien el Sheet real.

### H4 — Asimetría de validación entre Pacientes y Turnos/Cobros (confirmado, se extiende a Cobros) — ✅ RESUELTO (sin bloquear)

- **Severidad**: medio
- **Ubicación**: `aplicarDataset` (`index.html:1387-1399`), `normalizarTurno` (`index.html:1346-1349`), `normalizarCobro` (`index.html:1350-1353`)
- **Descripción**: `aplicarDataset` bloquea la carga completa del dataset si algún `Paciente.id` no es numérico, pero **no aplica ningún chequeo equivalente a `Turno.pacienteId` ni a `Cobro.pacienteId`** — ambos se normalizan con `Number(...)` sin `Number.isFinite`, así que un valor inválido se convierte en `NaN` silenciosamente y nunca bloquea ni señala nada. Ya documentado como riesgo en la spec (FR-005); esta auditoría confirma que afecta también a Cobros, no solo a Turnos.
- **¿Cubierto por el fix de H1/H2?** Parcialmente — el fix asegura que el backend **escriba** bien el id, pero no agrega ninguna validación nueva del lado del frontend. Este hallazgo sigue abierto.
- **Relacionado**: `PacienteSearchSelect` arma el desplegable de "elegir paciente" (para Turnos) leyendo el estado `pacientes` ya cargado en memoria, sin releer del servidor en el momento de la selección — mismo patrón de "confiar en estado local sin confirmar" ya identificado en H1.
- **Estado**: ✅ **corregido, decisión explícita de no bloquear.** Se decidió junto al usuario (dado que hoy existen turnos reales en producción con `pacienteId` inválido, y bloquear toda la carga habría roto la app apenas se desplegara) que la extensión de esta validación **no** replique el comportamiento de `Paciente.id` (bloqueo total vía `setError`). En cambio, `aplicarDataset` (`index.html`) ahora cuenta turnos/cobros con `pacienteId` no numérico y emite un `console.warn` (visible en devtools, no bloqueante) si hay alguno — la carga de la app sigue funcionando con normalidad en cualquier caso.

### H5 — Condición de carrera al generar un cobro automático (NO relacionado a headers)

- **Severidad**: medio
- **Ubicación**: `setEstadoTurno` (`index.html:1478-1496`)
- **Descripción**: al marcar un turno como "realizado", el chequeo `yaExiste = cobros.some(...)` (línea 1486) compara contra el estado `cobros` capturado en el cierre de la función — no contra una lectura fresca del servidor. Si la acción se dispara más de una vez seguida (doble click, dos turnos marcados casi al mismo tiempo), el chequeo puede no detectar un cobro que ya está en proceso de crearse, generando un **cobro duplicado** para la misma sesión.
- **¿Cubierto por el fix de H1/H2?** No — es un mecanismo completamente distinto (condición de carrera en el frontend, no un problema de headers). Necesita arreglo aparte (ej. deshabilitar el botón mientras la petición está en curso, o deduplicar del lado del servidor).
- **Estado**: ✅ **corregido y verificado con una prueba de concurrencia real**, no solo revisión de código.
  - Primer intento: se agregó `buscarCobroExistente`/`leerCampoObjeto` en `doPost` (chequeo de duplicado contra el Sheet antes de crear un Cobro). Al probarlo en el **entorno de test** (`backend-appsscript-test/`, Sheet separado) disparando **dos requests realmente en paralelo** (no secuenciales), se descubrió que **no alcanzaba**: Apps Script puede ejecutar dos `doPost` al mismo tiempo de verdad, y ambas requests leían el Sheet "vacío" a la vez, calculando el mismo `getNextId` → **2 filas con el mismo id** en el Sheet de test (peor que el síntoma original). Este es un problema más de fondo que el propio `getNextId`, compartido por las 3 hojas, no solo Cobros.
  - **Fix final**: se envolvió todo el bloque `create`/`update`/`delete` de `doPost` en `LockService.getScriptLock()` (`lock.waitLock(10000)` al entrar, `lock.releaseLock()` en un `finally`), serializando cualquier escritura concurrente para las 3 hojas por igual.
  - **Verificado**: se repitió exactamente el mismo test de 2 requests en paralelo contra el Sheet de test con el fix del lock ya desplegado ahí — el Sheet quedó con **1 sola fila** (antes: 2 con id duplicado). Los datos de prueba usados se limpiaron del Sheet de test en cada paso.
  - Código idéntico entre `backend-appsscript/` (producción) y `backend-appsscript-test/` (test) confirmado por diff (solo difieren en `SHEET_ID`). ✅ pusheado, ✅ nueva implementación creada, ✅ `API_URL` actualizada en `index.html:1284`, ✅ verificado que la implementación nueva lee correctamente el Sheet real. **Pendiente**: prueba end-to-end manual en producción (marcar un turno "realizado" dos veces rápido y confirmar que no se duplica el cobro).

### H6 — Datos del profesional y plantillas de WhatsApp viven solo en `localStorage` (mecanismo de guardado totalmente distinto)

- **Severidad**: bajo/medio (depende de cuántos dispositivos use Lupita)
- **Ubicación**: `index.html:602-616` (`datosProfesional`), `index.html:645-674` (plantillas `plantilla_<tipo>`)
- **Descripción**: ninguno de estos dos datos pasa por el Google Sheet ni por `Código.js` — se guardan y leen exclusivamente del `localStorage` del navegador. Esto implica: (a) no sincroniza entre dispositivos/navegadores distintos; (b) se pierde permanentemente si se borran los datos del sitio, sin backup; (c) el guardado de `datosProfesional` falla en silencio (`catch` vacío, línea 615-616) sin avisar al usuario, a diferencia de las plantillas que sí muestran una alerta si falla el guardado (línea 672-674).
- **¿Cubierto por el fix de H1/H2?** No aplica — ni siquiera pasa por el código que se corrigió. Es una decisión de producto (¿vale la pena moverlo al Sheet?) más que un bug puntual.

### H7 — Métricas: sin riesgo propio de sincronización

- **Severidad**: informativo (no es un hallazgo de fragilidad)
- **Ubicación**: `MetricasView` (`index.html:1262-1276`)
- **Descripción**: es una vista puramente derivada — no hace ningún `apiCall` propio, solo calcula sobre `pacientes`/`turnos`/`cobros` ya cargados en memoria. Cualquier número incorrecto que muestre (ej. "ingreso promedio por paciente" contando turnos huérfanos) es reflejo directo de H1-H5, no un bug nuevo de Métricas.

### H8 — Cobros ya queda cubierto por el fix generalizado (confirmación, no un nuevo hallazgo)

- **Severidad**: informativo
- **Ubicación**: `Código.js` — no existe código separado para "Cobros"; usa el mismo router genérico (`doPost`/`buildRow`/`updateRowById`/`sheetToObjects`) que Pacientes y Turnos.
- **Descripción**: el fix de H1/H2 (normalización de headers en `buildRow`/`updateRowById`) aplica automáticamente a Cobros sin necesidad de ningún cambio adicional.
- **Pendiente de verificación** (no se hizo en esta auditoría porque hoy no hay ningún cobro cargado en producción para inspeccionar sus claves crudas): revisar visualmente que el header de la columna id en "Cobros" sea razonable antes de que se cargue el primer cobro real — dado el historial de errores de tipeo ya encontrado dos veces (Pacientes, Turnos), aunque el fix ya desplegado debería tolerar cualquier variante de mayúscula/espacio.

### Confirmación positiva — Principio III (flush obligatorio)

`SpreadsheetApp.flush()` está presente y en el orden correcto en los 3 únicos puntos de escritura (`create`, `update`, `delete` en `doPost`, líneas 53-78), de forma centralizada para las 3 hojas por igual. **No se encontró ningún gap** — este punto ya estaba bien resuelto antes de esta auditoría.

## Nota de alcance — T002, T009-T011, T013 no fueron necesarias

Las tareas T002 (confirmar acceso de edición al Sheet), T009-T011 (crear paciente/turno de prueba en producción) y T013 (limpiar datos de prueba) **no se ejecutaron, y no hizo falta ejecutarlas**. La causa raíz de H1 quedó confirmada con una vía de menor riesgo: Jonatan verificó personalmente el texto exacto de las celdas A1 de "Pacientes" y "Turnos" (sin necesidad de que un agente navegue el Sheet de producción con historia clínica real, ni de crear/borrar datos de prueba), lo cual coincidió exactamente con la hipótesis levantada por análisis estático del código. Esto cierra US1 sin haber tocado en ningún momento los datos reales de producción.

Se detectó además, como observación aparte (fuera del alcance formal de esta auditoría — no es un hallazgo de sincronización Pacientes-Turnos): `Código.js:29` tiene la contraseña de acceso compartida (`CLAVE_ACCESO`) hardcodeada en texto plano en el archivo fuente. No se propone acción al respecto en este informe (Principio IV: no se toca el esquema de autenticación sin pedido explícito) — se deja mencionado únicamente para que quede registrado.
