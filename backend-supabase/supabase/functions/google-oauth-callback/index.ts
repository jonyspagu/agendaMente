// Vuelta del OAuth de Google Calendar. Google redirige acá con ?code=...&state=...
// tras el consentimiento; `state` es un nonce de un solo uso que el frontend
// pidió con crear_estado_oauth_google() justo antes de mandarla a Google (antes
// era el JWT de la sesión, que quedaba en la URL y en el historial del navegador).
//
// Al conectar: se guardan los tokens, se crea (o se reutiliza) un calendario
// propio "agendaMente" en su cuenta — el scope calendar.app.created solo deja
// tocar calendarios creados por la app, nunca el resto de su Google — y se
// encolan todos los turnos de hoy en adelante (encolar_backfill_google).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
// Tiene que calzar EXACTO con la redirect URI registrada en Google Cloud Console
// (incluida acá misma, no en el frontend, porque Google la valida contra la que
// se usó al pedir el `code`).
const GOOGLE_REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://app.agendamente.com.ar";

async function notificarErrorRpc(contexto: string, mensaje: string) {
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await admin.rpc("notificar_error", { p_contexto: contexto, p_mensaje: mensaje });
  } catch (_e) {
    // nunca romper por esto
  }
}

function redirect(destino: string) {
  return new Response(null, { status: 302, headers: { Location: destino } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // La profesional canceló el consentimiento, o Google mandó algo sin `code`.
  if (errorParam || !code || !state) {
    return redirect(`${APP_URL}/?gcal=error`);
  }

  try {
    // 1. `state` = nonce de un solo uso (vence a los 10 minutos). Se consume
    // acá: un segundo intento con el mismo state falla.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profesionalId, error: stateError } = await admin.rpc("consumir_estado_oauth_google", { p_nonce: state });
    if (stateError || !profesionalId) return redirect(`${APP_URL}/?gcal=error`);

    // 2. Intercambiar el code por access_token + refresh_token.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => ({}));

    // Sin refresh_token no sirve de nada (no podríamos renovar el acceso
    // pasada una hora) — pasa si el frontend no mandó prompt=consent y la
    // profesional ya había autorizado antes.
    if (!tokenRes.ok || !tokenBody.access_token || !tokenBody.refresh_token) {
      await notificarErrorRpc(
        "googleOauthCallback",
        "Intercambio de code falló o vino sin refresh_token: " + JSON.stringify(tokenBody).slice(0, 300),
      );
      return redirect(`${APP_URL}/?gcal=error`);
    }

    const expiresAt = new Date(Date.now() + (Number(tokenBody.expires_in) || 3600) * 1000).toISOString();

    // 3. Guardar tokens encriptados — solo lo puede hacer service_role (ver
    // migración 20260924120000). calendar_id de la tabla de tokens quedó sin
    // uso: el calendario vigente vive en profesionales.google_calendar_id.
    const { error: guardarError } = await admin.rpc("guardar_tokens_google", {
      p_profesional_id: profesionalId,
      p_access_token: tokenBody.access_token,
      p_refresh_token: tokenBody.refresh_token,
      p_expires_at: expiresAt,
      p_calendar_id: "primary",
    });
    if (guardarError) throw new Error(guardarError.message);

    // 4. Calendario "agendaMente": si ya había uno de una conexión anterior y
    // sigue existiendo, se reutiliza (así no se duplican calendarios al
    // reconectar); si no, se crea.
    const authHeader = { Authorization: `Bearer ${tokenBody.access_token}` };
    const { data: prof } = await admin.from("profesionales").select("google_calendar_id").eq("id", profesionalId).single();
    let calendarId = prof?.google_calendar_id as string | null;
    if (calendarId) {
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, { headers: authHeader });
      await res.body?.cancel();
      if (!res.ok) calendarId = null;
    }
    if (!calendarId) {
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "agendaMente", timeZone: "America/Argentina/Buenos_Aires" }),
      });
      const cal = await res.json().catch(() => ({}));
      if (!res.ok || !cal.id) throw new Error(`No se pudo crear el calendario agendaMente (${res.status}): ${JSON.stringify(cal).slice(0, 300)}`);
      calendarId = cal.id as string;
    }

    // 5. Marcar como conectada (y limpiar un problema anterior, si lo había).
    const { error: marcarError } = await admin
      .from("profesionales")
      .update({
        google_calendar_conectado_at: new Date().toISOString(),
        google_calendar_id: calendarId,
        google_calendar_problema: null,
      })
      .eq("id", profesionalId);
    if (marcarError) throw new Error(marcarError.message);

    // 6. Mandar los turnos que ya tenía cargados (de hoy en adelante). Si esto
    // falla la conexión igual quedó hecha: el cron de cada hora levanta los
    // 'pendiente'.
    const { error: backfillError } = await admin.rpc("encolar_backfill_google", { p_profesional_id: profesionalId });
    if (backfillError) await notificarErrorRpc("googleOauthCallback", "Backfill falló: " + backfillError.message);

    return redirect(`${APP_URL}/?gcal=ok`);
  } catch (e) {
    await notificarErrorRpc("googleOauthCallback", String(e));
    return redirect(`${APP_URL}/?gcal=error`);
  }
});
