/**
 * BACKEND DEL CONSULTORIO — Google Apps Script
 * ---------------------------------------------
 * Expone una API REST muy simple sobre un Google Sheet con 3 hojas:
 * Pacientes, Turnos, Cobros.
 *
 * Este backend es GENÉRICO: arma cada fila leyendo los encabezados reales
 * de la hoja en el momento. Si en el futuro agregás una columna nueva en el
 * Sheet, no hace falta tocar este archivo — el backend la va a reconocer sola
 * en cuanto el frontend empiece a mandar ese campo.
 *
 * SETUP (una sola vez):
 * 1. Creá un Google Sheet nuevo. Renombrá las 3 hojas exactamente así:
 *    "Pacientes", "Turnos", "Cobros" (respetando mayúsculas).
 * 2. Cargá los encabezados en la fila 1 de cada hoja (el primero siempre "id").
 * 3. Extensiones → Apps Script. Borrá el contenido de Code.gs y pegá TODO este archivo.
 * 4. Arriba de todo, reemplazá SHEET_ID por el ID de tu planilla
 *    (está en la URL: docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit).
 * 5. Implementar → Nueva implementación → tipo "Aplicación web".
 *    - Ejecutar como: Yo
 *    - Quién tiene acceso: Cualquier usuario
 * 6. Copiá la URL que te da ("Web app URL") y pasámela — con eso termino de conectar el frontend.
 */

const SHEET_ID = "1VCby0fYi0w8Sa3luBtqiX97mTzOicnDAWmw8Zz6qYY0";

// Contraseña de acceso. CAMBIALA por la que quieras usar.
// Sin esta clave, ni la app ni nadie con la URL puede leer o escribir datos.
const CLAVE_ACCESO = "Consul123";

// Mail al que se avisa cuando algo se rompe de verdad en el backend (no
// errores esperables como contraseña incorrecta).
const EMAIL_ALERTAS = "jonatanrpagura@gmail.com";

// Throttling con CacheService: como mucho 1 mail por tipo de error cada 30
// minutos, para no inundar la bandeja si algo empieza a fallar en bucle.
function notificarError(contexto, mensaje) {
  try {
    const cache = CacheService.getScriptCache();
    const clave = "alerta_" + contexto;
    if (cache.get(clave)) return;
    cache.put(clave, "1", 1800);
    MailApp.sendEmail({
      to: EMAIL_ALERTAS,
      subject: "AgendaMente — error en producci\xF3n: " + contexto,
      body: mensaje + "\n\nHora: " + new Date().toString()
    });
  } catch (mailErr) {
  }
}

function doGet(e) {
  try {
    var clave = e && e.parameter ? e.parameter.clave : null;
    if (clave !== CLAVE_ACCESO) {
      return jsonResponse({ ok: false, error: "NO_AUTORIZADO" });
    }
    procesarCobrosMensualesVencidos();
    procesarTurnosRecurrentes();
    var data = getAllData();
    data.ok = true;
    return jsonResponse(data);
  } catch (err) {
    notificarError("doGet", String(err));
    return jsonResponse({ ok: false, error: "Error inesperado del servidor: " + String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const { sheet, action, id, data, clave } = body;

    if (clave !== CLAVE_ACCESO) {
      return jsonResponse({ ok: false, error: "NO_AUTORIZADO" });
    }

    if (action === "pulirNota") {
      return jsonResponse(pulirNotaConIA(data));
    }

    const ss = SpreadsheetApp.openById(SHEET_ID);
    if (sheet === "Config") ensureConfigSheet(ss);
    const sh = ss.getSheetByName(sheet);
    if (!sh) return jsonResponse({ ok: false, error: "Hoja no encontrada: " + sheet });

    // Valida integridad referencial antes de crear un Turno o un Cobro (H3):
    // que el pacienteId corresponda a un paciente real en "Pacientes". Se hace
    // ANTES de tomar el lock (evita retenerlo si la request se va a rechazar).
    if (action === "create" && (sheet === "Turnos" || sheet === "Cobros")) {
      if (!pacienteExiste(data.pacienteId)) {
        return jsonResponse({
          ok: false,
          error: `El paciente indicado (id ${data.pacienteId}) no existe. No se guardó el ${sheet === "Turnos" ? "turno" : "cobro"}.`
        });
      }
    }

    if (action === "create" || action === "update" || action === "delete") {
      // Serializa SOLO la parte que necesita exclusividad (generar id + escribir
      // + flush) — dos requests casi simultáneas pueden correr en paralelo de
      // verdad en Apps Script, y sin esto ambas leen el Sheet "vacío" a la vez
      // y calculan el mismo getNextId → dos filas con el mismo id.
      // getAllData() queda AFUERA del lock a propósito: no necesita exclusividad
      // (solo lee) y es la parte más lenta de la request — tenerla adentro
      // hacía que cada escritura bloqueara a la siguiente por varios segundos.
      const lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
      } catch (lockErr) {
        return jsonResponse({ ok: false, error: "El servidor está ocupado, probá de nuevo en unos segundos." });
      }
      let idCobroExistente = null;
      let nuevoId = null;
      try {
        if (action === "create") {
          // Evita cobros duplicados si el frontend dispara la creación más de
          // una vez para el mismo paciente+fecha (H5). Se chequea contra el
          // Sheet, no contra lo que mande el cliente.
          if (sheet === "Cobros") {
            const existente = buscarCobroExistente(sh, data);
            if (existente) idCobroExistente = Number(leerCampoObjeto(existente, "id"));
          }
          if (idCobroExistente === null) {
            nuevoId = getNextId(sh);
            const row = buildRow(sh, nuevoId, data);
            sh.appendRow(row);
            SpreadsheetApp.flush(); // fuerza que la escritura se confirme antes de soltar el lock
          }
        } else if (action === "update") {
          const debeRegistrarHistorial = sheet === "Turnos" || sheet === "Cobros";
          const filaAntes = debeRegistrarHistorial ? buscarFilaPorId(sh, id) : null;
          updateRowById(sh, id, data);
          SpreadsheetApp.flush();
          if (filaAntes) registrarCambioHistorial(ss, sheet, "update", filaAntes, data);
        } else {
          const debeRegistrarHistorial = sheet === "Turnos" || sheet === "Cobros";
          const filaAntes = debeRegistrarHistorial ? buscarFilaPorId(sh, id) : null;
          deleteRowById(sh, id);
          SpreadsheetApp.flush();
          if (filaAntes) registrarCambioHistorial(ss, sheet, "delete", filaAntes, null);
        }
      } finally {
        lock.releaseLock();
      }

      const result = getAllData();
      result.ok = true;
      if (action === "create") result.id = idCobroExistente !== null ? idCobroExistente : nuevoId;
      return jsonResponse(result);
    }

    return jsonResponse({ ok: false, error: "Acción desconocida: " + action });
  } catch (err) {
    notificarError("doPost", String(err));
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normalizeValue(v, header) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    if (String(header).toLowerCase().trim() === "hora") {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), "HH:mm");
    }
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return v;
}

function sheetToObjects(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter((row) => row[0] !== "" && row[0] !== null)
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = normalizeValue(row[i], h)));
      return obj;
    });
}

// Verifica que exista un paciente con ese id en "Pacientes" (H3).
function pacienteExiste(pacienteId) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const pacientesSh = ss.getSheetByName("Pacientes");
  if (!pacientesSh) return false;
  const idNum = Number(pacienteId);
  return sheetToObjects(pacientesSh).some((p) => Number(leerCampoObjeto(p, "id")) === idNum);
}

// Cobro mensual de las pacientes con tipoPago="mensual": un solo cobro por
// mes calendario YA CERRADO, fechado el último día de ese mes (así figura en
// el mes de las sesiones y no en el siguiente — bug real reportado por Guada
// 2026-10), por precio × sesiones que se cobran ("realizado" + "canceló, se
// cobra"). Antes se cobraba "precio" una sola vez por mes, sin importar
// cuántas sesiones hubo. La cantidad queda en la columna "sesiones": la usa
// la etiqueta del cobro ("Mensual septiembre · 4 sesiones") y sirve para
// saber si el monto lo puso el sistema o lo editó ella a mano.
//
// Si marca una sesión tarde (ej. el 3/10 marca realizada la del 28/9), el
// cobro de septiembre se recalcula solo en la próxima lectura — mientras siga
// pendiente y nadie le haya editado el monto a mano. Pagado o editado a mano:
// no se toca nunca. El recálculo automático no deja rastro en Historial (es
// el sistema, no una edición de la profesional).
//
// Regla vigente desde septiembre 2026 (MES_INICIO_COBRO_MENSUAL): los cobros
// de la regla vieja (monto fijo, un mes después de "desde") no se reprocesan.
const MES_INICIO_COBRO_MENSUAL = "2026-09";
const MESES_RECALCULO_COBRO_MENSUAL = 3;
const ESTADOS_TURNO_QUE_SE_COBRAN = ["realizado", "cancelado_cobra"];
const ESTADOS_TURNO_CANCELADOS = ["cancelado", "cancelado_cobra"];

function procesarCobrosMensualesVencidos() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return;
  }
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const pacientesSh = ss.getSheetByName("Pacientes");
    const cobrosSh = ss.getSheetByName("Cobros");
    const turnosSh = ss.getSheetByName("Turnos");
    if (!pacientesSh || !cobrosSh || !turnosSh) return;
    asegurarColumna(cobrosSh, "sesiones");

    const pacientes = sheetToObjects(pacientesSh);
    const turnos = sheetToObjects(turnosSh);
    const cobros = sheetToObjects(cobrosSh);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    // Los últimos meses cerrados (el actual todavía no), sin bajar del inicio
    // de la regla. Ej. hoy 3/10 → ["2026-09"] (agosto ya es regla vieja).
    const mesesARevisar = [];
    let mes = mesAnterior(formatearFecha(hoy).slice(0, 7));
    while (mesesARevisar.length < MESES_RECALCULO_COBRO_MENSUAL && mes >= MES_INICIO_COBRO_MENSUAL) {
      mesesARevisar.push(mes);
      mes = mesAnterior(mes);
    }

    pacientes.forEach((p) => {
      if (normalizarHeader(leerCampoObjeto(p, "tipoPago")) !== "mensual") return;
      const pacienteId = Number(leerCampoObjeto(p, "id"));
      const precio = Number(leerCampoObjeto(p, "precio")) || 0;
      if (!precio) return;
      const desde = String(leerCampoObjeto(p, "desde") || "");
      const mesDesde = /^\d{4}-\d{2}/.test(desde) ? desde.slice(0, 7) : "";

      mesesARevisar.forEach((mesCobro) => {
        if (mesDesde && mesCobro < mesDesde) return;
        const fechaCobro = ultimoDiaDelMes(mesCobro);
        const sesiones = turnos.filter(
          (t) => Number(leerCampoObjeto(t, "pacienteId")) === pacienteId && String(leerCampoObjeto(t, "fecha")).slice(0, 7) === mesCobro && ESTADOS_TURNO_QUE_SE_COBRAN.includes(String(leerCampoObjeto(t, "estado")))
        ).length;
        const existente = cobros.find(
          (c) => Number(leerCampoObjeto(c, "pacienteId")) === pacienteId && String(leerCampoObjeto(c, "fecha")) === fechaCobro
        );

        if (!existente) {
          if (sesiones === 0) return;
          const row = buildRow(cobrosSh, getNextId(cobrosSh), {
            pacienteId: pacienteId,
            fecha: fechaCobro,
            monto: precio * sesiones,
            estado: "pendiente",
            sesiones: sesiones
          });
          cobrosSh.appendRow(row);
          SpreadsheetApp.flush();
          return;
        }

        // Recalcular solo un cobro armado por el sistema (tiene "sesiones"),
        // todavía pendiente y con el monto tal cual lo dejó el sistema.
        if (String(leerCampoObjeto(existente, "estado")) !== "pendiente") return;
        const sesionesCrudo = leerCampoObjeto(existente, "sesiones");
        if (sesionesCrudo === "" || sesionesCrudo === null || sesionesCrudo === void 0) return;
        const sesionesGuardadas = Number(sesionesCrudo);
        if (Number(leerCampoObjeto(existente, "monto")) !== precio * sesionesGuardadas) return;
        if (sesionesGuardadas === sesiones) return;
        updateRowById(cobrosSh, leerCampoObjeto(existente, "id"), { monto: precio * sesiones, sesiones: sesiones });
        SpreadsheetApp.flush();
      });
    });
  } finally {
    lock.releaseLock();
  }
}

// "2026-01" → "2025-12"
function mesAnterior(mes) {
  const partes = mes.split("-").map(Number);
  return formatearFecha(new Date(partes[0], partes[1] - 2, 1)).slice(0, 7);
}

// "2026-09" → "2026-09-30" (día 0 del mes siguiente = último día de este)
function ultimoDiaDelMes(mes) {
  const partes = mes.split("-").map(Number);
  return formatearFecha(new Date(partes[0], partes[1], 0));
}

// Genera sola la próxima sesión de las pacientes con turno fijo (columna
// "turnoRecurrente" = "SI"), sin que la profesional tenga que apretar
// "Repetir turno" cada vez. Mantiene siempre al menos un turno futuro
// agendado, usando su frecuencia (frecuenciaDias) y el horario de su último
// turno como referencia. Si nunca tuvo un turno, no genera nada (no hay de
// dónde partir la fecha/hora).
function procesarTurnosRecurrentes() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return;
  }
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const pacientesSh = ss.getSheetByName("Pacientes");
    const turnosSh = ss.getSheetByName("Turnos");
    if (!pacientesSh || !turnosSh) return;
    asegurarColumna(pacientesSh, "turnoRecurrente");

    const pacientes = sheetToObjects(pacientesSh);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    pacientes.forEach((p) => {
      if (normalizarHeader(leerCampoObjeto(p, "turnoRecurrente")) !== "si") return;
      const pacienteId = Number(leerCampoObjeto(p, "id"));
      const frecuenciaDias = Number(leerCampoObjeto(p, "frecuenciaDias")) || 7;

      let iteraciones = 0;
      while (iteraciones < 12) {
        const turnosPaciente = sheetToObjects(turnosSh).filter(
          (t) => Number(leerCampoObjeto(t, "pacienteId")) === pacienteId
        );
        if (turnosPaciente.length === 0) return;

        let ultimo = null;
        turnosPaciente.forEach((t) => {
          const f = parsearFecha(leerCampoObjeto(t, "fecha"));
          if (isNaN(f.getTime())) return;
          if (!ultimo || f > ultimo.fecha) ultimo = { fecha: f, hora: leerCampoObjeto(t, "hora") };
        });
        if (!ultimo || ultimo.fecha > hoy) break;

        const proxima = new Date(ultimo.fecha);
        proxima.setDate(proxima.getDate() + frecuenciaDias);
        const proximaStr = formatearFecha(proxima);

        const todosLosTurnos = sheetToObjects(turnosSh);
        const yaExiste = todosLosTurnos.some(
          (t) => Number(leerCampoObjeto(t, "pacienteId")) === pacienteId && leerCampoObjeto(t, "fecha") === proximaStr && String(leerCampoObjeto(t, "hora")) === String(ultimo.hora)
        );
        const ocupadoPorOtra = todosLosTurnos.some(
          (t) => Number(leerCampoObjeto(t, "pacienteId")) !== pacienteId && leerCampoObjeto(t, "fecha") === proximaStr && String(leerCampoObjeto(t, "hora")) === String(ultimo.hora) && !ESTADOS_TURNO_CANCELADOS.includes(String(leerCampoObjeto(t, "estado")))
        );
        if (!yaExiste && !ocupadoPorOtra) {
          const nuevoId = getNextId(turnosSh);
          const row = buildRow(turnosSh, nuevoId, {
            pacienteId: pacienteId,
            fecha: proximaStr,
            hora: ultimo.hora,
            estado: "agendado"
          });
          turnosSh.appendRow(row);
          SpreadsheetApp.flush();
        }
        iteraciones++;
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// Si la hoja no tiene esa columna todavía, la agrega al final (las filas
// existentes quedan en blanco para esa columna) — permite sumar campos
// nuevos sin tener que editar el Sheet a mano.
function asegurarColumna(sh, nombre) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const existe = headers.some((h) => normalizarHeader(h) === normalizarHeader(nombre));
  if (!existe) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue(nombre);
    SpreadsheetApp.flush();
  }
}

// Le pide a Claude que redacte/pula una nota de historia clínica según el
// marco teórico configurado, a partir del texto tal cual lo escribió la
// profesional. Nunca se guarda sola — siempre vuelve al frontend para que
// ella la revise antes de guardar.
function pulirNotaConIA(data) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "Falta configurar la clave de la IA en el servidor." };
  }
  const notaOriginal = String((data && data.notaOriginal) || "").trim();
  if (!notaOriginal) {
    return { ok: false, error: "No hay texto para pulir." };
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const config = sheetToObjects(ensureConfigSheet(ss))[0] || {};
  const marco = String(leerCampoObjeto(config, "marcoTeorico") || "").trim();

  const promptMarco = marco
    ? `La profesional trabaja desde un marco teórico ${marco}. Redactá usando ese enfoque y su vocabulario habitual.`
    : "No se especificó un marco teórico particular: redactá de forma profesional y neutral.";

  const prompt = `Sos un asistente que ayuda a un psicólogo a redactar la entrada de una historia clínica a partir de una nota informal que él mismo escribió después de una sesión.

${promptMarco}

Reglas importantes:
- No inventes ni agregues contenido clínico que no esté en la nota original.
- Mejorá solo la redacción: claridad, prolijidad, vocabulario profesional.
- Escribilo en tercera persona ("la paciente refiere...", "se observa...").
- Respondé Únicamente con el texto final de la nota, sin explicaciones ni comentarios adicionales.

Nota original:
"""
${notaOriginal}
"""`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  const modelo = "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

  // Gemini a veces devuelve "alta demanda" (error transitorio, no de la
  // clave ni del código) — se reintenta un par de veces antes de mostrarle
  // un error a la profesional.
  let status, body;
  for (let intento = 0; intento < 3; intento++) {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    status = response.getResponseCode();
    body = JSON.parse(response.getContentText());
    if (status === 200) break;
    if (intento < 2) Utilities.sleep(2000);
  }

  if (status !== 200) {
    const detalle = "La IA no pudo procesar la nota: " + (body.error ? body.error.message : "error desconocido");
    notificarError("pulirNotaConIA", detalle);
    return { ok: false, error: detalle };
  }
  const candidato = body.candidates && body.candidates[0];
  const textoPulido = candidato && candidato.content && candidato.content.parts && candidato.content.parts[0] && candidato.content.parts[0].text || "";
  if (!textoPulido) {
    return { ok: false, error: "La IA no devolvió ningún texto." };
  }
  return { ok: true, textoPulido: textoPulido.trim() };
}

function parsearFecha(s) {
  const partes = String(s).split("-").map(Number);
  return new Date(partes[0], partes[1] - 1, partes[2]);
}

function formatearFecha(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// Suma un mes calendario respetando fin de mes (31/1 + 1 mes = 28 o 29/2, no 3/3).
function sumarUnMes(d) {
  const dia = d.getDate();
  const res = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const ultimoDiaMes = new Date(res.getFullYear(), res.getMonth() + 1, 0).getDate();
  res.setDate(Math.min(dia, ultimoDiaMes));
  return res;
}

// Datos del profesional (nombre/matrícula/especialidad) y las plantillas de
// WhatsApp: antes vivían solo en el localStorage del navegador (se perdían si
// Guada cambiaba de compu/navegador). Ahora quedan en una fila única de esta
// hoja, igual que el resto de los datos. Se autocrea la primera vez que hace
// falta, para no depender de un paso manual de setup en el Sheet.
function ensureConfigSheet(ss) {
  let sh = ss.getSheetByName("Config");
  if (!sh) {
    sh = ss.insertSheet("Config");
    sh.getRange(1, 1, 1, 7).setValues([
      ["id", "nombreProfesional", "matricula", "especialidad", "plantillaDeuda", "plantillaSimple", "plantillaAumento"]
    ]);
    sh.appendRow([1, "", "", "", "", "", ""]);
    SpreadsheetApp.flush();
  }
  asegurarColumna(sh, "marcoTeorico");
  return sh;
}

// Registro de auditoría de ediciones/eliminaciones en Cobros y Turnos (creación
// no se loguea: es el flujo normal del día a día y sería puro ruido). Se
// autocrea la primera vez que hace falta, igual que Config.
function ensureHistorialSheet(ss) {
  let sh = ss.getSheetByName("Historial");
  if (!sh) {
    sh = ss.insertSheet("Historial");
    sh.getRange(1, 1, 1, 7).setValues([
      ["id", "fecha", "hoja", "accion", "pacienteId", "antes", "cambios"]
    ]);
    SpreadsheetApp.flush();
  }
  return sh;
}

function getAllData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return {
    pacientes: sheetToObjects(ss.getSheetByName("Pacientes")),
    turnos: sheetToObjects(ss.getSheetByName("Turnos")),
    cobros: sheetToObjects(ss.getSheetByName("Cobros")),
    config: sheetToObjects(ensureConfigSheet(ss))[0] || {},
    historial: sheetToObjects(ensureHistorialSheet(ss)),
  };
}

function getNextId(sh) {
  const values = sh.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < values.length; i++) {
    const v = Number(values[i][0]);
    if (v > max) max = v;
  }
  return max + 1;
}

// Normaliza un header/clave para compararlos sin que mayúsculas o espacios
// (typos de tipeo al armar el Sheet) rompan silenciosamente el guardado.
function normalizarHeader(h) {
  return String(h).trim().toLowerCase();
}

// Arma la fila leyendo los encabezados REALES de la hoja (columna por columna),
// en vez de tener una lista de campos fija por hoja. Así, agregar una columna
// nueva en el Sheet ya alcanza — no hace falta tocar este archivo nunca más.
function buildRow(sh, id, data) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const claves = Object.keys(data);
  return headers.map((h) => {
    const hNorm = normalizarHeader(h);
    if (hNorm === "id") return id;
    const clave = claves.find((k) => normalizarHeader(k) === hNorm);
    return clave !== void 0 ? data[clave] : "";
  });
}

// Lee un campo de un objeto armado por sheetToObjects tolerando que la clave
// real tenga otra mayúscula/espacio (mismo criterio que buildRow/updateRowById).
function leerCampoObjeto(obj, nombre) {
  const objetivo = normalizarHeader(nombre);
  const clave = Object.keys(obj).find((k) => normalizarHeader(k) === objetivo);
  return clave !== void 0 ? obj[clave] : void 0;
}

// Busca, en el estado ACTUAL del Sheet (no en lo que mande el cliente), si ya
// existe un cobro para el mismo paciente y la misma fecha (H5).
function buscarCobroExistente(sh, data) {
  const pacienteId = Number(data.pacienteId);
  const fecha = String(data.fecha);
  return sheetToObjects(sh).find(
    (o) => Number(leerCampoObjeto(o, "pacienteId")) === pacienteId && String(leerCampoObjeto(o, "fecha")) === fecha
  );
}

// Lee el estado ACTUAL de una fila por id, antes de mutarla — updateRowById y
// deleteRowById no lo hacen, así que hace falta leerlo aparte para poder dejar
// constancia del "antes" en el Historial.
function buscarFilaPorId(sh, id) {
  return sheetToObjects(sh).find((o) => String(leerCampoObjeto(o, "id")) === String(id));
}

// Deja constancia en "Historial" de un update/delete sobre Cobros o Turnos,
// con suficiente info estructurada para que el frontend arme una frase legible
// (paciente, qué decía antes, qué cambió). "antes" guarda la fila completa tal
// cual estaba (genérico, sirve para cualquier hoja); "cambios" son los campos
// que mandó el frontend en el update (vacío en un delete).
function registrarCambioHistorial(ss, sheet, accion, filaAntes, cambios) {
  const historialSh = ensureHistorialSheet(ss);
  const nuevoId = getNextId(historialSh);
  const row = buildRow(historialSh, nuevoId, {
    fecha: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
    hoja: sheet,
    accion: accion,
    pacienteId: leerCampoObjeto(filaAntes, "pacienteId") || "",
    antes: JSON.stringify(filaAntes),
    cambios: accion === "update" ? JSON.stringify(cambios) : ""
  });
  historialSh.appendRow(row);
  SpreadsheetApp.flush();
}

function updateRowById(sh, id, data) {
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(normalizarHeader);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) {
      Object.keys(data).forEach((key) => {
        const col = headers.indexOf(normalizarHeader(key));
        if (col >= 0) sh.getRange(i + 1, col + 1).setValue(data[key]);
      });
      break;
    }
  }
}

function deleteRowById(sh, id) {
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) {
      sh.deleteRow(i + 1);
      break;
    }
  }
}