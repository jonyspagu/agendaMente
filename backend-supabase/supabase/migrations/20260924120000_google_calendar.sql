-- Sincronización de Turnos → Google Calendar, un solo sentido (AgendaMente
-- escribe en el Google Calendar de cada profesional; no se lee el calendario
-- de Google). Cada profesional conecta su propia cuenta una vez; los tokens
-- OAuth se guardan encriptados (pgcrypto, ya habilitado), nunca en claro.

-- 1. Estado de sincronización por turno.
alter table public.turnos
  add column if not exists google_event_id text,
  add column if not exists google_sync_status text not null default 'pendiente'
    check (google_sync_status in ('pendiente', 'sincronizado', 'error')),
  add column if not exists google_sync_error text;

-- 2. Flag de "conectada" visible para el frontend — la escribe únicamente la
-- Edge Function (con service_role) al completar el OAuth, nunca la propia
-- profesional directo (mismo criterio que ia_activada en 20260921130000).
alter table public.profesionales
  add column if not exists google_calendar_conectado_at timestamptz;
revoke update (google_calendar_conectado_at) on public.profesionales from authenticated;

-- 3. Tokens OAuth, encriptados, en una tabla aparte — nunca en profesionales
-- directo, y sin ninguna policy (default-deny total para anon/authenticated,
-- mismo patrón que alertas_throttle). Solo accesible vía las funciones
-- security definer de abajo o con la service_role key.
create table public.google_calendar_tokens (
  profesional_id uuid primary key references public.profesionales(id) on delete cascade,
  access_token_enc bytea not null,
  refresh_token_enc bytea not null,
  expires_at timestamptz not null,
  calendar_id text not null default 'primary',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.google_calendar_tokens enable row level security;

-- 4. Guardar (alta o renovación) los tokens de una profesional, encriptados
-- con una clave simétrica única guardada en Vault (mismo patrón que
-- resend_api_key: el secret se crea a mano, fuera de esta migración, con
-- select vault.create_secret('<clave>', 'google_tokens_encryption_key')).
create or replace function public.guardar_tokens_google(
  p_profesional_id uuid,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_calendar_id text default 'primary'
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_clave text;
begin
  select decrypted_secret into v_clave
  from vault.decrypted_secrets
  where name = 'google_tokens_encryption_key';

  if v_clave is null then
    raise exception 'google_tokens_encryption_key no está configurado en Vault';
  end if;

  insert into public.google_calendar_tokens
    (profesional_id, access_token_enc, refresh_token_enc, expires_at, calendar_id, updated_at)
  values (
    p_profesional_id,
    pgp_sym_encrypt(p_access_token, v_clave),
    pgp_sym_encrypt(p_refresh_token, v_clave),
    p_expires_at,
    coalesce(p_calendar_id, 'primary'),
    now()
  )
  on conflict (profesional_id) do update set
    access_token_enc = excluded.access_token_enc,
    refresh_token_enc = excluded.refresh_token_enc,
    expires_at = excluded.expires_at,
    calendar_id = excluded.calendar_id,
    updated_at = now();
end;
$$;

-- 5. Leer (desencriptados) los tokens vigentes de una profesional. Devuelve
-- cero filas si nunca conectó o si desconectó (ver eliminar_tokens_google).
create or replace function public.obtener_tokens_google(p_profesional_id uuid)
returns table (access_token text, refresh_token text, expires_at timestamptz, calendar_id text)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_clave text;
begin
  select decrypted_secret into v_clave
  from vault.decrypted_secrets
  where name = 'google_tokens_encryption_key';

  if v_clave is null then
    raise exception 'google_tokens_encryption_key no está configurado en Vault';
  end if;

  return query
  select
    pgp_sym_decrypt(t.access_token_enc, v_clave),
    pgp_sym_decrypt(t.refresh_token_enc, v_clave),
    t.expires_at,
    t.calendar_id
  from public.google_calendar_tokens t
  where t.profesional_id = p_profesional_id;
end;
$$;

-- 6. Desconectar: borra los tokens y limpia el flag de "conectada". Sin
-- parámetro a propósito — usa auth.uid() (quien está realmente logueada),
-- nunca un id que venga del cliente: si tomara p_profesional_id como
-- parámetro, cualquier usuaria autenticada podría desconectar la cuenta de
-- Google de OTRA profesional con solo cambiar el uuid que manda.
create or replace function public.eliminar_tokens_google()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.google_calendar_tokens where profesional_id = auth.uid();
  update public.profesionales set google_calendar_conectado_at = null where id = auth.uid();
end;
$$;

-- Igual que en el resto del repo: el schema public da EXECUTE a
-- anon/authenticated/service_role por default en toda función nueva —
-- revocar solo de PUBLIC no alcanza. Estas tres funciones tocan tokens OAuth
-- ajenos: solo service_role (las Edge Functions) puede invocarlas.
revoke execute on function public.guardar_tokens_google(uuid, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.obtener_tokens_google(uuid) from public, anon, authenticated;
revoke execute on function public.eliminar_tokens_google() from public, anon;
grant execute on function public.guardar_tokens_google(uuid, text, text, timestamptz, text) to service_role;
grant execute on function public.obtener_tokens_google(uuid) to service_role;
-- eliminar_tokens_google la invoca el frontend directo (botón "Desconectar"),
-- ya autenticada — segura para authenticated porque solo opera sobre
-- auth.uid(), nunca sobre un id que venga del cliente.
grant execute on function public.eliminar_tokens_google() to authenticated;

-- 7. Reintentos: turnos que quedaron en 'error' se vuelven a intentar una vez
-- por día, mismo esqueleto que procesar_cobros_mensuales_vencidos (loop con
-- notificar_error por fila, filtro por suscripción activa). net.http_post es
-- fire-and-forget: si vuelve a fallar, la Edge Function deja el estado en
-- 'error' de nuevo y el cron del día siguiente reintenta.
create or replace function public.procesar_reintentos_google_calendar()
returns void
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  r record;
  v_url text := 'https://rtkllwucobddekdkfoux.supabase.co/functions/v1/sync-turno-google';
  v_service_key text;
begin
  select decrypted_secret into v_service_key
  from vault.decrypted_secrets
  where name = 'service_role_key_para_cron';

  if v_service_key is null then
    perform public.notificar_error('cron_reintentos_google_calendar', 'falta el secret service_role_key_para_cron en Vault');
    return;
  end if;

  for r in
    select t.id, t.profesional_id
    from public.turnos t
    join public.profesionales pr on pr.id = t.profesional_id
    where t.google_sync_status = 'error'
      and pr.estado_suscripcion in ('trial', 'activa')
    limit 200
  loop
    begin
      perform net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object('accion', 'update', 'turnoId', r.id)
      );
    exception when others then
      perform public.notificar_error('cron_reintentos_google_calendar', 'turno ' || r.id || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

revoke execute on function public.procesar_reintentos_google_calendar() from public, anon, authenticated;
grant execute on function public.procesar_reintentos_google_calendar() to postgres;

select cron.schedule('agendamente-reintentos-google-calendar', '20 6 * * *', $$select public.procesar_reintentos_google_calendar();$$);
