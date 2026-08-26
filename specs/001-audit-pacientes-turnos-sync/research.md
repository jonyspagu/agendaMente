# Research: Auditoría de Estabilidad — Sincronización Pacientes-Turnos

## Decisión 1: Método de acceso al código backend (Apps Script)

- **Decision**: Instalar `clasp` bajo demanda vía `npx @google/clasp <comando>` (sin instalación global ni dependencia persistente del proyecto). Autenticar con `npx clasp login` — flujo OAuth interactivo en navegador que debe completar Jonatan manualmente (no automatizable por un agente). Obtener el Script ID del proyecto Apps Script vinculado a la Web App actual (Project Settings en el editor de script.google.com — no se puede derivar del `API_URL` de despliegue, que es un deployment ID distinto). Clonar con `npx clasp clone <scriptId> --rootDir ./backend-appsscript`.
- **Rationale**: El usuario eligió explícitamente esta vía en la clarificación de la spec. `clasp` es la herramienta oficial de Google para sincronizar proyectos de Apps Script con un repo local, permite referenciar archivo:línea exactos en el informe de auditoría, y deja el código versionado para auditorías futuras.
- **Alternatives considered**:
  - Copiar/pegar manualmente el código desde el editor web: rechazado por ser propenso a errores de transcripción y no dejar nada versionado.
  - Auditar solo por comportamiento observado (sin ver el código): rechazado explícitamente por el usuario — es la opción que NO eligió en la clarificación, y de por sí no permite confirmar causa raíz, solo síntomas.

## Decisión 2: Ubicación y alcance del código clonado

- **Decision**: El código clonado vive en `backend-appsscript/` en la raíz del repo, tratado como material de solo lectura para esta auditoría (no se edita ni se hacen cambios de producto sobre él en esta tarea).
- **Rationale**: Mantiene la separación entre "lo que ya existe" (frontend en `index.html`, backend ahora visible en `backend-appsscript/`) y el propio trabajo de auditoría (`specs/001-.../`). Satisface el Principio V (mínima superficie nueva) porque es una carpeta agregada por pedido explícito del usuario, no una decisión de alcance tomada unilateralmente.
- **Alternatives considered**: Repo separado solo para el backend — rechazado por agregar complejidad innecesaria (dos repos para auditar un solo bug); no versionar el código y solo tomar notas — rechazado porque impide citar líneas exactas de forma verificable en el informe.

## Decisión 3: Protocolo de datos de prueba (sin entorno de staging)

- **Decision**: Toda reproducción que implique crear un paciente o turno real en el Sheet de producción usa un nombre inconfundible (ej. `ZZZ_AUDITORIA_<timestamp>`) para poder identificarlo y borrarlo manualmente después de cada paso de reproducción. La auditoría documenta explícitamente, para cada prueba realizada, qué filas quedaron creadas y deben eliminarse.
- **Rationale**: El usuario confirmó en la clarificación que no existe un Sheet de prueba separado y que se trabaja directamente sobre producción; esto exige minimizar y controlar cualquier efecto secundario sobre los datos reales de Lupita (FR-012).
- **Alternatives considered**: Duplicar el Sheet de producción como entorno temporal de prueba — el usuario tuvo esta opción disponible en la clarificación y explícitamente eligió "no, todo en producción" en su lugar.

## Decisión 4: Metodología para rastrear la causa raíz del bug crítico

- **Decision**: Combinar (a) revisión estática del frontend ya disponible, (b) revisión estática del backend una vez clonado vía clasp, y (c) reproducción mínima y controlada en producción (Decisión 3) para confirmar hipótesis de timing/condiciones de carrera que no se pueden confirmar solo leyendo código.
- **Rationale**: El análisis estático del frontend ya permitió identificar, sin necesidad de reproducción, un mecanismo concreto de fragilidad (ver "Hallazgo preliminar" abajo). Pero confirmar si el backend efectivamente falla en generar/persistir el ID (y no solo que el frontend lo maneja mal si falla) requiere ver el código server-side; y confirmar condiciones de carrera requiere reproducción real.
- **Alternatives considered**: Solo análisis estático (rechazado: no puede confirmar hipótesis de timing/flush); solo reproducción en vivo sin leer el backend (rechazado: es exactamente la limitación ya identificada en la exploración previa — no permite establecer causa raíz, solo síntomas).

## Hallazgo preliminar (confirmado por análisis estático, sin necesidad de reproducción)

Ya se identificó, leyendo `index.html:1534-1566` (`agregarPaciente`), un mecanismo concreto de fragilidad que la auditoría debe profundizar:

- Línea 1556: `const nuevoId = Number(res.id);` — si el backend devuelve `res.id` vacío o `undefined` (coherente con el síntoma reportado: columna ID vacía en la hoja), `nuevoId` resulta en `NaN`.
- Líneas 1557-1562: el merge del estado local es "optimista" — si `nuevoId` no aparece en `res.pacientes` (lista que el propio backend devuelve), el código igual agrega el paciente al estado local con `{ ...nuevo, id: nuevoId }`, sin alertar al usuario ni reintentar. Como `NaN !== NaN`, la comprobación `lista.some((p) => p.id === nuevoId)` en la línea 1560 siempre da `false` en este caso, por lo que el paciente inválido se agrega igual.
- Consecuencia observable: el paciente aparece "creado" en la UI (con un ID inválido en memoria), pero en la próxima recarga completa de datos, `aplicarDataset` (línea 1387-1399) detecta el `id` no numérico y **bloquea la carga completa** del dataset (pacientes, turnos y cobros), mostrando un error genérico — coherente con turnos que "se guardan" (su propio ID en la hoja "Turnos" sí es numérico y correcto) pero quedan sin poder mostrar el nombre del paciente vinculado.

Esto NO cierra el diagnóstico (falta confirmar por qué el backend no está persistiendo o devolviendo el ID en primer lugar — requiere ver `backend-appsscript/`), pero da a la auditoría un punto de partida concreto y ya evidenciado para las Fases de ejecución (`/speckit-tasks` → `/speckit-implement`).

## Resumen de unknowns resueltos

Todos los `NEEDS CLARIFICATION` del Technical Context quedaron resueltos con la información disponible del repo (no había ninguno real pendiente de research externo — el proyecto no usa un lenguaje/framework exótico que requiera investigación de mercado). El único "unknown" genuino era el método de acceso al backend, resuelto en la Decisión 1.
