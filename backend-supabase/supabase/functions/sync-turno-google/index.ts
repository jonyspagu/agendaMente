// Sincroniza UN turno hacia el calendario "agendaMente" de su profesional (un
// solo sentido: acá nunca se lee lo que hay en Google). La invocan únicamente
// los triggers de la base (turno_encolar_sync_google, paciente_encolar_sync_google)
// y los crons/backfill, vía net.http_post — nunca el navegador. Por eso exige
// el header `x-agendamente-sync` con el secreto compartido de Vault
// (`sync_google_secret` = env SYNC_GOOGLE_SECRET); se deploya con
// --no-verify-jwt porque esa es la protección real.
//
// Idempotente: el id del evento en Google es el uuid del turno sin guiones, así
// que reenviar el mismo turno (reintentos, carreras, backfill) nunca duplica.
//
// Si la profesional nunca conectó Google (o se desconectó), es un no-op.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SYNC_GOOGLE_SECRET = Deno.env.get("SYNC_GOOGLE_SECRET") ?? "";

// No existe ningún campo de duración de sesión en el schema hoy — se asume
// una duración fija. Fácil de convertir en columna configurable después.
const DURACION_MINUTOS = 50;

const PROBLEMA_PERMISO = "Se perdió el permiso de Google Calendar. Volvé a conectarlo para que tus turnos se sigan copiando.";
const PROBLEMA_CALENDARIO = "No encontramos el calendario agendaMente en tu Google (¿lo borraste?). Volvé a conectar Google Calendar para crearlo de nuevo.";

type Admin = ReturnType<typeof createClient>;
type Tokens = { access_token: string; refresh_token: string; expires_at: string; calendar_id: string };

// Google cortó el acceso (permiso revocado, refresh token vencido, calendario
// borrado). No tiene sentido reintentar: hay que avisarle a ella.
class ConexionPerdida extends Error {
  constructor(public motivo: string, detalle: string) {
    super(detalle);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function secretoValido(recibido: string | null) {
  if (!SYNC_GOOGLE_SECRET || !recibido) return false;
  const a = new TextEncoder().encode(recibido);
  const b = new TextEncoder().encode(SYNC_GOOGLE_SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function notificarErrorRpc(admin: Admin, contexto: string, mensaje: string) {
  try {
    await admin.rpc("notificar_error", { p_contexto: contexto, p_mensaje: mensaje });
  } catch (_e) {
    // nunca romper por esto
  }
}

// hora viene de Postgres como "HH:MM:SS" (o a veces "HH:MM"). Se arma un
// datetime naive y se le suma la duración con aritmética simple — Argentina
// no tiene horario de verano hoy, así que sumar minutos en un offset fijo es
// seguro (no hay salto de DST que pisar).
function calcularInicioYFin(fecha: string, hora: string) {
  const horaCorta = hora.length >= 5 ? hora.slice(0, 5) : hora;
  const inicioIso = `${fecha}T${horaCorta}:00`;
  const inicioMs = new Date(`${inicioIso}Z`).getTime();
  const finIso = new Date(inicioMs + DURACION_MINUTOS * 60_000).toISOString().slice(0, 19);
  return { inicioIso, finIso };
}

// Solo iniciales: Google Calendar se ve en el celular, en notificaciones y se
// puede compartir — el nombre completo de un paciente es dato de salud.
function tituloEvento(nombre?: string | null, apellido?: string | null) {
  const iniciales = [nombre, apellido]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .map((s) => s[0].toLocaleUpperCase("es-AR") + ".")
    .join(" ");
  return iniciales ? `Turno — ${iniciales}` : "Turno";
}

// uuid "3f2a…-…" → "3f2a…" (hex es subconjunto de base32hex, el alfabeto que
// Google acepta para ids propios).
function idEvento(turnoId: string) {
  return turnoId.replace(/-/g, "").toLowerCase();
}

async function refrescarTokenSiHaceFalta(admin: Admin, profesionalId: string, tokens: Tokens, forzar = false) {
  const vencePronto = new Date(tokens.expires_at).getTime() - Date.now() < 2 * 60_000;
  if (!vencePronto && !forzar) return tokens;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const detalle = "No se pudo renovar el token de Google: " + JSON.stringify(body).slice(0, 300);
    // invalid_grant = el permiso ya no existe (revocado, o vencido a los 7
    // días mientras la app siga en modo Testing). Otros errores son transitorios.
    if (body.error === "invalid_grant") throw new ConexionPerdida(PROBLEMA_PERMISO, detalle);
    throw new Error(detalle);
  }

  const nuevoAccessToken = body.access_token as string;
  // Google normalmente NO devuelve un refresh_token nuevo al renovar — se
  // conserva el que ya teníamos.
  const nuevoRefreshToken = body.refresh_token || tokens.refresh_token;
  const nuevoExpiresAt = new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000).toISOString();

  const { error } = await admin.rpc("guardar_tokens_google", {
    p_profesional_id: profesionalId,
    p_access_token: nuevoAccessToken,
    p_refresh_token: nuevoRefreshToken,
    p_expires_at: nuevoExpiresAt,
    p_calendar_id: tokens.calendar_id,
  });
  if (error) throw new Error(error.message);

  return { ...tokens, access_token: nuevoAccessToken, refresh_token: nuevoRefreshToken, expires_at: nuevoExpiresAt };
}

// Llamada a la API de Calendar con un reintento si Google devuelve 401 (token
// invalidado antes de su vencimiento): se fuerza una renovación y, si el
// segundo intento también da 401, la conexión se da por perdida.
async function llamarGoogle(
  admin: Admin,
  profesionalId: string,
  estado: { tokens: Tokens },
  url: string,
  init: { method: string; body?: unknown },
) {
  for (let intento = 0; intento < 2; intento++) {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${estado.tokens.access_token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status !== 401) return res;
    if (intento === 0) {
      estado.tokens = await refrescarTokenSiHaceFalta(admin, profesionalId, estado.tokens, true);
    } else {
      throw new ConexionPerdida(PROBLEMA_PERMISO, "Google Calendar respondió 401 incluso con un token recién renovado");
    }
  }
  throw new Error("inalcanzable");
}

// Google responde 404 tanto si no existe el evento como si no existe el
// calendario. Para distinguirlos se consulta el calendario.
async function calendarioExiste(admin: Admin, profesionalId: string, estado: { tokens: Tokens }, calendarId: string) {
  const res = await llamarGoogle(admin, profesionalId, estado,
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, { method: "GET" });
  await res.body?.cancel();
  return res.status !== 404 && res.status !== 410;
}

async function borrarEvento(admin: Admin, profesionalId: string, estado: { tokens: Tokens }, calendarId: string, eventId: string) {
  const res = await llamarGoogle(admin, profesionalId, estado,
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "DELETE" });
  const texto = await res.text().catch(() => "");
  // 404/410 = ya no existe del lado de Google (o nunca llegó): no es un error.
  if (res.ok || res.status === 410) return;
  if (res.status === 404) {
    if (!(await calendarioExiste(admin, profesionalId, estado, calendarId))) {
      throw new ConexionPerdida(PROBLEMA_CALENDARIO, "El calendario agendaMente ya no existe");
    }
    return;
  }
  throw new Error(`Google Calendar API (${res.status}) al borrar: ${texto.slice(0, 300)}`);
}

// Crear o actualizar. PATCH primero, con status "confirmed": si ella borró el
// evento a mano en Google, el evento queda como "cancelled" con el mismo id, y
// esto lo vuelve a mostrar (antes quedaba invisible y el turno decía
// "sincronizado"). 404 → no existe todavía → POST con id propio. 409 en el
// POST → otro request lo creó en el medio → PATCH de nuevo.
async function guardarEvento(admin: Admin, profesionalId: string, estado: { tokens: Tokens }, calendarId: string, eventId: string, evento: Record<string, unknown>) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const patch = () => llamarGoogle(admin, profesionalId, estado, `${base}/${eventId}`, { method: "PATCH", body: { ...evento, status: "confirmed" } });

  let res = await patch();
  if (res.status === 404) {
    await res.body?.cancel();
    if (!(await calendarioExiste(admin, profesionalId, estado, calendarId))) {
      throw new ConexionPerdida(PROBLEMA_CALENDARIO, "El calendario agendaMente ya no existe");
    }
    res = await llamarGoogle(admin, profesionalId, estado, base, { method: "POST", body: { ...evento, id: eventId } });
    if (res.status === 409) {
      await res.body?.cancel();
      res = await patch();
    }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar API (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
}

// Ella pierde la conexión: se borran los tokens (ya no sirven), se marca el
// problema para que la app se lo muestre, y se avisa por mail una sola vez
// (las llamadas siguientes encuentran la cuenta ya desconectada y son no-op).
async function marcarConexionPerdida(admin: Admin, profesionalId: string, e: ConexionPerdida) {
  await admin.from("google_calendar_tokens").delete().eq("profesional_id", profesionalId);
  await admin
    .from("profesionales")
    .update({ google_calendar_conectado_at: null, google_calendar_problema: e.motivo })
    .eq("id", profesionalId);
  await notificarErrorRpc(admin, "syncGoogleCalendar", `Profesional ${profesionalId} desconectada de Google: ${e.message}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!secretoValido(req.headers.get("x-agendamente-sync"))) return json({ ok: false, error: "No autorizado" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let turnoId: string | undefined;
  let profesionalId: string | undefined;

  try {
    const body = await req.json();
    const accion = body.accion as string;
    turnoId = body.turnoId;
    profesionalId = body.profesionalId;
    if ((accion !== "sync" && accion !== "delete") || !turnoId || !profesionalId) {
      return json({ ok: false, error: "Falta accion, turnoId o profesionalId" }, 400);
    }

    const { data: tokensRows } = await admin.rpc("obtener_tokens_google", { p_profesional_id: profesionalId });
    const tokens = tokensRows?.[0] as Tokens | undefined;
    if (!tokens) return json({ ok: true, info: "profesional no conectada a Google Calendar" });

    const { data: prof } = await admin.from("profesionales").select("google_calendar_id").eq("id", profesionalId).single();
    const calendarId = prof?.google_calendar_id as string | undefined;
    if (!calendarId) return json({ ok: true, info: "profesional sin calendario agendaMente (conexión vieja)" });

    const estado = { tokens: await refrescarTokenSiHaceFalta(admin, profesionalId, tokens) };
    const eventId = idEvento(turnoId);

    // --- BORRADO: el turno ya no existe en la tabla.
    if (accion === "delete") {
      await borrarEvento(admin, profesionalId, estado, calendarId, eventId);
      return json({ ok: true });
    }

    const { data: turno } = await admin
      .from("turnos")
      .select("id, profesional_id, fecha, hora, estado, pacientes(nombre, apellido)")
      .eq("id", turnoId)
      .maybeSingle();
    // Borrado entre que se encoló el aviso y ahora: el aviso de 'delete' se
    // encarga (o ya se encargó) del evento.
    if (!turno) return json({ ok: true, info: "turno ya no existe" });
    if (turno.profesional_id !== profesionalId) return json({ ok: false, error: "profesional no coincide" }, 400);

    // Cancelado (y "canceló, se cobra") no ocupa la agenda: se borra el evento.
    if (turno.estado === "cancelado" || turno.estado === "cancelado_cobra") {
      await borrarEvento(admin, profesionalId, estado, calendarId, eventId);
      await admin.from("turnos").update({ google_event_id: null, google_sync_status: "sincronizado", google_sync_error: null }).eq("id", turnoId);
      return json({ ok: true, info: "evento de turno cancelado eliminado" });
    }

    const paciente = Array.isArray(turno.pacientes) ? turno.pacientes[0] : turno.pacientes;
    const { inicioIso, finIso } = calcularInicioYFin(turno.fecha as string, turno.hora as string);
    await guardarEvento(admin, profesionalId, estado, calendarId, eventId, {
      summary: tituloEvento(paciente?.nombre, paciente?.apellido),
      description: "Generado automáticamente por agendaMente. Los cambios hechos acá (en Google Calendar) no se reflejan de vuelta en la app — para reprogramar o cancelar, hacelo desde agendaMente.",
      start: { dateTime: inicioIso, timeZone: "America/Argentina/Buenos_Aires" },
      end: { dateTime: finIso, timeZone: "America/Argentina/Buenos_Aires" },
    });

    await admin.from("turnos").update({ google_event_id: eventId, google_sync_status: "sincronizado", google_sync_error: null }).eq("id", turnoId);
    return json({ ok: true, googleEventId: eventId });
  } catch (e) {
    if (e instanceof ConexionPerdida && profesionalId) {
      await marcarConexionPerdida(admin, profesionalId, e);
      if (turnoId) {
        await admin.from("turnos").update({ google_sync_status: "error", google_sync_error: e.message.slice(0, 300) }).eq("id", turnoId);
      }
      return json({ ok: false, error: e.message }, 409);
    }
    // Error transitorio: el turno queda en 'error' y el cron de cada hora lo
    // reintenta (si el turno todavía existe — para 'delete' es best-effort).
    if (turnoId) {
      await admin.from("turnos").update({ google_sync_status: "error", google_sync_error: String(e).slice(0, 300) }).eq("id", turnoId);
    }
    await notificarErrorRpc(admin, "syncGoogleCalendar", `turno ${turnoId}: ${String(e)}`);
    return json({ ok: false, error: String(e) }, 500);
  }
});
