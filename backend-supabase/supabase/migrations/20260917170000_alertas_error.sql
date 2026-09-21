-- Alertas de error por mail, con el mismo throttle (1 por contexto cada 30
-- min) que notificarError() tenía en el backend viejo de Apps Script.
-- Sin esto, un error que se repite en loop podría mandar cientos de mails.
create extension if not exists pg_net;

-- Sin policies a propósito: default-deny total para anon/authenticated.
-- Solo el trigger/las funciones security definer (que corren como el
-- dueño de la función, no como el usuario logueado) pueden tocar esta tabla.
create table public.alertas_throttle (
  contexto text primary key,
  last_sent_at timestamptz
);
alter table public.alertas_throttle enable row level security;

-- Único punto de entrada para "avisame por mail si algo se rompió".
-- Nunca debe poder romper a quien la llama (ver exception handler al final).
create or replace function public.notificar_error(p_contexto text, p_mensaje text)
returns void
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_last timestamptz;
  v_resend_key text;
begin
  select last_sent_at into v_last
  from public.alertas_throttle
  where contexto = p_contexto
  for update;

  if v_last is not null and now() - v_last < interval '30 minutes' then
    return;
  end if;

  insert into public.alertas_throttle (contexto, last_sent_at)
  values (p_contexto, now())
  on conflict (contexto) do update set last_sent_at = excluded.last_sent_at;

  select decrypted_secret into v_resend_key
  from vault.decrypted_secrets
  where name = 'resend_api_key';

  if v_resend_key is null then
    return; -- secret todavía no configurado (se crea a mano, fuera de esta migración)
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_resend_key
    ),
    body := jsonb_build_object(
      'from', 'AgendaMente <onboarding@resend.dev>',
      'to', jsonb_build_array('jonys.pagu@gmail.com'),
      'subject', 'AgendaMente — error en producción: ' || p_contexto,
      'text', p_mensaje || E'\n\n' || now()::text
    )
  );
exception when others then
  null; -- nunca dejar que el alerting rompa al que lo llamó
end;
$$;

-- CRÍTICO: por default Postgres otorga EXECUTE a PUBLIC (anon + authenticated
-- incluidos). Sin este revoke, cualquier usuario logueado podría invocar esto
-- vía sb.rpc('notificar_error', ...) y mandar mails con contexto arbitrario.
-- service_role sí la necesita: la Edge Function pulir-nota la invoca por RPC
-- con la service role key cuando Gemini falla persistentemente.
-- El schema public tiene default privileges que dan EXECUTE a anon/
-- authenticated/service_role en toda función nueva automáticamente — revocar
-- solo de PUBLIC no alcanza, hay que revocar explícito de esos roles.
revoke execute on function public.notificar_error(text, text) from public, anon, authenticated;
grant execute on function public.notificar_error(text, text) to postgres, service_role;
