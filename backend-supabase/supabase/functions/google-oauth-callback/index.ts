// Vuelta del OAuth de Google Calendar. Google redirige acá con ?code=...&state=...
// tras el consentimiento; `state` es el access token de la sesión que inició la
// conexión (viaja en la URL de vuelta, nunca se loguea acá ni se persiste en
// ningún lado más allá de esta única invocación, que dura milisegundos).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
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
    // 1. `state` = el access token de la sesión que abrió el flujo. Se usa
    // una sola vez, acá, para identificar de quién es la conexión — nunca se
    // loguea (ni siquiera en un catch) ni se guarda en ningún lado.
    const supabaseComoUsuario = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${state}` } },
    });
    const { data: { user } } = await supabaseComoUsuario.auth.getUser();
    if (!user) return redirect(`${APP_URL}/?gcal=error`);

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

    // 3. Guardar tokens encriptados y marcar la cuenta como conectada — ambas
    // cosas solo las puede hacer service_role (ver migración 20260924120000).
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error: guardarError } = await admin.rpc("guardar_tokens_google", {
      p_profesional_id: user.id,
      p_access_token: tokenBody.access_token,
      p_refresh_token: tokenBody.refresh_token,
      p_expires_at: expiresAt,
      p_calendar_id: "primary",
    });
    if (guardarError) throw new Error(guardarError.message);

    const { error: marcarError } = await admin
      .from("profesionales")
      .update({ google_calendar_conectado_at: new Date().toISOString() })
      .eq("id", user.id);
    if (marcarError) throw new Error(marcarError.message);

    return redirect(`${APP_URL}/?gcal=ok`);
  } catch (e) {
    await notificarErrorRpc("googleOauthCallback", String(e));
    return redirect(`${APP_URL}/?gcal=error`);
  }
});
