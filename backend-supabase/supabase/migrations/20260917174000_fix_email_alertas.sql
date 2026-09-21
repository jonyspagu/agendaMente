-- El mail de alertas viejo (jonatanrpagura@gmail.com, hardcodeado de
-- Código.js) no es la casilla dueña de la cuenta de Resend usada acá
-- (jonys.pagu@gmail.com) — en modo sandbox, Resend solo permite mandar a esa
-- casilla. Se corrige el destino.
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
    return;
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
  null;
end;
$$;

revoke execute on function public.notificar_error(text, text) from public, anon, authenticated;
grant execute on function public.notificar_error(text, text) to postgres, service_role;
