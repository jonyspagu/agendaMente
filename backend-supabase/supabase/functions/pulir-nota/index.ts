// Reconexión de "Pulir con IA" (Código.js:344-415), ahora como Edge Function.
// El texto de la nota nunca se persiste ni se loguea acá: solo transita en
// memoria durante la llamada a Gemini y vuelve al navegador. La historia
// clínica sigue encriptándose recién al guardarse (frontend-supabase),
// así que esto no cambia en nada la garantía de confidencialidad existente.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = "gemini-flash-latest";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function construirPrompt(marco: string, notaOriginal: string): string {
  const promptMarco = marco
    ? `La persona profesional trabaja desde un marco teórico ${marco}. Redactá usando ese enfoque y su vocabulario habitual.`
    : "No se especificó un marco teórico particular: redactá de forma profesional y neutral.";

  return `Sos un asistente que ayuda a un/a profesional de la psicología a redactar la entrada de una historia clínica a partir de una nota informal que la misma persona escribió después de una sesión.

${promptMarco}

Reglas importantes:
- No inventes ni agregues contenido clínico que no esté en la nota original.
- Mejorá solo la redacción: claridad, prolijidad, vocabulario profesional.
- Escribilo en tercera persona ("el/la paciente refiere...", "se observa...").
- Respondé Únicamente con el texto final de la nota, sin explicaciones ni comentarios adicionales.

Nota original:
"""
${notaOriginal}
"""`;
}

async function notificarErrorRpc(contexto: string, mensaje: string) {
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await admin.rpc("notificar_error", { p_contexto: contexto, p_mensaje: mensaje });
  } catch (_e) {
    // nunca romper por esto
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ ok: false, error: "No hay sesión activa." }, 401);

    if (!GEMINI_API_KEY) {
      return json({ ok: false, error: "Falta configurar la clave de la IA en el servidor." }, 500);
    }

    const { notaOriginal } = await req.json();
    const nota = String(notaOriginal ?? "").trim();
    if (!nota) {
      return json({ ok: false, error: "No hay texto para pulir." });
    }

    const { data: prof, error: profErr } = await supabase
      .from("profesionales")
      .select("marco_teorico, ia_activada")
      .eq("id", user.id)
      .single();
    if (profErr) throw new Error(profErr.message);

    // Opt-in: la función viene apagada y la profesional la activa (con aviso)
    // desde Configuración. Se valida acá también, no solo en el botón.
    if (!prof?.ia_activada) {
      return json({ ok: false, error: "La función de IA está desactivada. Podés activarla en Configuración." });
    }

    const prompt = construirPrompt(String(prof?.marco_teorico ?? "").trim(), nota);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    let status = 0;
    let body: any = null;
    // Gemini a veces devuelve "alta demanda" (error transitorio) — se
    // reintenta un par de veces antes de mostrarle un error a la profesional.
    for (let intento = 0; intento < 3; intento++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      status = response.status;
      body = await response.json().catch(() => ({}));
      if (status === 200) break;
      if (intento < 2) await new Promise((r) => setTimeout(r, 2000));
    }

    if (status !== 200) {
      const detalle = "La IA no pudo procesar la nota: " + (body?.error?.message || "error desconocido");
      await notificarErrorRpc("pulirNotaConIA", detalle);
      return json({ ok: false, error: detalle }, 502);
    }

    const textoPulido = body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!textoPulido) {
      return json({ ok: false, error: "La IA no devolvió ningún texto." });
    }

    return json({ ok: true, textoPulido: String(textoPulido).trim() });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
