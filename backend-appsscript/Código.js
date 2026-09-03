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

function doGet(e) {
  var clave = e && e.parameter ? e.parameter.clave : null;
  if (clave !== CLAVE_ACCESO) {
    return jsonResponse({ ok: false, error: "NO_AUTORIZADO" });
  }
  procesarCobrosMensualesVencidos();
  var data = getAllData();
  data.ok = true;
  return jsonResponse(data);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const { sheet, action, id, data, clave } = body;

    if (clave !== CLAVE_ACCESO) {
      return jsonResponse({ ok: false, error: "NO_AUTORIZADO" });
    }
    const ss = SpreadsheetApp.openById(SHEET_ID);
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
          updateRowById(sh, id, data);
          SpreadsheetApp.flush();
        } else {
          deleteRowById(sh, id);
          SpreadsheetApp.flush();
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

// Genera solo el cobro mensual de cada paciente con tipoPago="mensual" cuando se
// cumple un mes desde su último cobro (o desde que arrancó, si todavía no tuvo
// ninguno). Así queda simétrico con las pacientes por sesión, donde el cobro
// también se genera solo (al marcar el turno "realizado" en la Agenda) sin que la
// profesional tenga que acordarse de apretar nada. Si estuvo varios meses sin
// generarse, pone al día todos los meses vencidos (con un tope de seguridad).
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
    if (!pacientesSh || !cobrosSh) return;

    const pacientes = sheetToObjects(pacientesSh);
    const cobros = sheetToObjects(cobrosSh);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    pacientes.forEach((p) => {
      if (normalizarHeader(leerCampoObjeto(p, "tipoPago")) !== "mensual") return;
      const pacienteId = Number(leerCampoObjeto(p, "id"));
      const desde = leerCampoObjeto(p, "desde");
      const precio = Number(leerCampoObjeto(p, "precio")) || 0;
      if (!desde || !precio) return;

      let referencia = parsearFecha(desde);
      if (isNaN(referencia.getTime())) return; // "desde" con formato no reconocido: no se puede calcular, se salta sin romper nada
      cobros
        .filter((c) => Number(leerCampoObjeto(c, "pacienteId")) === pacienteId)
        .forEach((c) => {
          const f = parsearFecha(leerCampoObjeto(c, "fecha"));
          if (!isNaN(f.getTime()) && f > referencia) referencia = f;
        });

      let iteraciones = 0;
      while (iteraciones < 24) {
        const proxima = sumarUnMes(referencia);
        if (proxima > hoy) break;
        const nuevoId = getNextId(cobrosSh);
        const row = buildRow(cobrosSh, nuevoId, {
          pacienteId: pacienteId,
          fecha: formatearFecha(proxima),
          monto: precio,
          estado: "pendiente"
        });
        cobrosSh.appendRow(row);
        SpreadsheetApp.flush();
        referencia = proxima;
        iteraciones++;
      }
    });
  } finally {
    lock.releaseLock();
  }
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

function getAllData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return {
    pacientes: sheetToObjects(ss.getSheetByName("Pacientes")),
    turnos: sheetToObjects(ss.getSheetByName("Turnos")),
    cobros: sheetToObjects(ss.getSheetByName("Cobros")),
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