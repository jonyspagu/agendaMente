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

    if (action === "create") {
      const newId = getNextId(sh);
      const row = buildRow(sh, newId, data);
      sh.appendRow(row);
      SpreadsheetApp.flush(); // fuerza que la escritura se confirme antes de releer
      const result = getAllData();
      result.ok = true;
      result.id = newId;
      return jsonResponse(result);
    }

    if (action === "update") {
      updateRowById(sh, id, data);
      SpreadsheetApp.flush();
      const result = getAllData();
      result.ok = true;
      return jsonResponse(result);
    }

    if (action === "delete") {
      deleteRowById(sh, id);
      SpreadsheetApp.flush();
      const result = getAllData();
      result.ok = true;
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