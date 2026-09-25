// Sincroniza UN turno hacia el Google Calendar de su profesional (un solo
// sentido: acá nunca se lee el calendario de Google). Se invoca fire-and-forget
// desde apiCall del frontend después de cada create/update/delete de Turnos, y
// también desde el cron de reintentos (procesar_reintentos_google_calendar)
// para los que quedaron en estado 'error'.
//
// Si la profesional nunca conectó Google (o se desconectó), esto es un no-op
// silencioso — no es un error, la mayoría de las cuentas no van a usarlo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

// No existe ningún campo de duración de sesión en el schema hoy — se asume
// una duración fija. Fácil de convertir en columna configurable después.
const DURACION_MINUTOS = 50;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function notificarErrorRpc(admin: ReturnType<typeof createClient>, contexto: string, mensaje: string) {
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

async function refrescarTokenSiHaceFalta(
  admin: ReturnType<typeof createClient>,
  profesionalId: string,
  tokens: { access_token: string; refresh_token: string; expires_at: string; calendar_id: string },
) {
  const vencePronto = new Date(tokens.expires_at).getTime() - Date.now() < 2 * 60_000;
  if (!vencePronto) return tokens;

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
    throw new Error("No se pudo renovar el token de Google: " + JSON.stringify(body).slice(0, 300));
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

async function marcarEstado(
  admin: ReturnType<typeof createClient>,
  turnoId: string,
  patch: { google_event_id?: string | null; google_sync_status: string; google_sync_error?: string | null },
) {
  await admin.from("turnos").update(patch).eq("id", turnoId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { accion, turnoId, profesionalId: profesionalIdBody, googleEventId: googleEventIdBody } = await req.json();
    if (!accion || !turnoId) return json({ ok: false, error: "Falta accion o turnoId" }, 400);

    // --- BORRADO: el turno ya no existe en la tabla (apiCall lo borra antes
    // de invocar esto), así que el frontend manda profesionalId/googleEventId
    // directo en el body en vez de que esta función los busque.
    if (accion === "delete") {
      if (!googleEventIdBody || !profesionalIdBody) {
        return json({ ok: true, info: "nada que borrar en Google (no estaba sincronizado o no conectada)" });
      }
      const { data: tokensRows } = await admin.rpc("obtener_tokens_google", { p_profesional_id: profesionalIdBody });
      const tokens = tokensRows?.[0];
      if (!tokens) return json({ ok: true, info: "profesional no conectada a Google Calendar" });

      const tokensVigentes = await refrescarTokenSiHaceFalta(admin, profesionalIdBody, tokens);
      const delRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(tokensVigentes.calendar_id)}/events/${googleEventIdBody}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tokensVigentes.access_token}` } },
      );
      // 404/410 = ya no existe del lado de Google, no es un error real.
      if (!delRes.ok && delRes.status !== 404 && delRes.status !== 410) {
        const detalle = await delRes.text().catch(() => "");
        await notificarErrorRpc(admin, "syncGoogleCalendar", `Borrado de evento falló (turno ya eliminado, sin reintento posible): ${detalle.slice(0, 300)}`);
        return json({ ok: false, error: "borrado en Google falló" }, 502);
      }
      return json({ ok: true });
    }

    // --- ALTA / EDICIÓN: el turno sigue existiendo, se re-trae completo.
    const { data: turno, error: turnoErr } = await admin
      .from("turnos")
      .select("id, profesional_id, paciente_id, fecha, hora, estado, google_event_id, pacientes(nombre, apellido)")
      .eq("id", turnoId)
      .single();
    if (turnoErr || !turno) return json({ ok: false, error: "turno no encontrado" }, 404);

    const { data: tokensRows } = await admin.rpc("obtener_tokens_google", { p_profesional_id: turno.profesional_id });
    const tokens = tokensRows?.[0];
    if (!tokens) return json({ ok: true, info: "profesional no conectada a Google Calendar" });

    const tokensVigentes = await refrescarTokenSiHaceFalta(admin, turno.profesional_id, tokens);

    // Cancelar un turno no borra la fila (setEstadoTurno solo cambia
    // `estado`) — sin este caso especial, un turno cancelado seguiría
    // apareciendo intacto en el Google Calendar de la profesional.
    if (turno.estado === "cancelado") {
      if (!turno.google_event_id) {
        return json({ ok: true, info: "turno cancelado, nunca había llegado a sincronizarse" });
      }
      const delRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(tokensVigentes.calendar_id)}/events/${turno.google_event_id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tokensVigentes.access_token}` } },
      );
      if (!delRes.ok && delRes.status !== 404 && delRes.status !== 410) {
        const detalle = await delRes.text().catch(() => "");
        await marcarEstado(admin, turnoId, { google_sync_status: "error", google_sync_error: `Borrado por cancelación falló: ${detalle.slice(0, 300)}` });
        await notificarErrorRpc(admin, "syncGoogleCalendar", `Borrado por cancelación falló (turno ${turnoId}): ${detalle.slice(0, 300)}`);
        return json({ ok: false, error: "borrado en Google falló" }, 502);
      }
      await marcarEstado(admin, turnoId, { google_event_id: null, google_sync_status: "sincronizado", google_sync_error: null });
      return json({ ok: true, info: "evento cancelado eliminado de Google Calendar" });
    }

    const paciente = Array.isArray(turno.pacientes) ? turno.pacientes[0] : turno.pacientes;
    const nombrePaciente = [paciente?.nombre, paciente?.apellido].filter(Boolean).join(" ") || "Paciente";
    const { inicioIso, finIso } = calcularInicioYFin(turno.fecha as string, turno.hora as string);

    const eventoBody = {
      summary: `Turno — ${nombrePaciente}`,
      description: "Generado automáticamente por agendaMente. Los cambios hechos acá (en Google Calendar) no se reflejan de vuelta en la app — para reprogramar o cancelar, hacelo desde agendaMente.",
      start: { dateTime: inicioIso, timeZone: "America/Argentina/Buenos_Aires" },
      end: { dateTime: finIso, timeZone: "America/Argentina/Buenos_Aires" },
    };

    const calendarBase = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(tokensVigentes.calendar_id)}/events`;
    const tieneEventoPrevio = accion === "update" && turno.google_event_id;
    const googleRes = await fetch(tieneEventoPrevio ? `${calendarBase}/${turno.google_event_id}` : calendarBase, {
      method: tieneEventoPrevio ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${tokensVigentes.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventoBody),
    });
    const googleBody = await googleRes.json().catch(() => ({}));

    if (!googleRes.ok) {
      const detalle = `Google Calendar API (${googleRes.status}): ${JSON.stringify(googleBody).slice(0, 300)}`;
      await marcarEstado(admin, turnoId, { google_sync_status: "error", google_sync_error: detalle });
      await notificarErrorRpc(admin, "syncGoogleCalendar", detalle);
      return json({ ok: false, error: detalle }, 502);
    }

    await marcarEstado(admin, turnoId, {
      google_event_id: googleBody.id,
      google_sync_status: "sincronizado",
      google_sync_error: null,
    });
    return json({ ok: true, googleEventId: googleBody.id });
  } catch (e) {
    await notificarErrorRpc(admin, "syncGoogleCalendar", String(e));
    return json({ ok: false, error: String(e) }, 500);
  }
});
