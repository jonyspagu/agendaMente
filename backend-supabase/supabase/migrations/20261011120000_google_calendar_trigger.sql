-- Google Calendar, segunda vuelta (después de la prueba de punta a punta del
-- 2026-10-10). Cambio de fondo: quien le avisa a Google ya no es el navegador
-- (dispararSyncGoogle en apiCall) sino un trigger sobre `turnos`. Así cualquier
-- camino que cree/edite/borre un turno sincroniza — incluidos los turnos
-- recurrentes que crea el cron con SQL directo y los borrados en cascada al
-- eliminar un paciente, que antes nunca llegaban a Google.
--
-- La Edge Function sync-turno-google deja de aceptar llamadas de afuera: exige
-- el header `x-agendamente-sync` con un secreto compartido que solo conocen
-- Vault (`sync_google_secret`) y la función (`SYNC_GOOGLE_SECRET`). Antes
-- cualquiera con la anon key (pública) podía borrar eventos de cualquier
-- profesional. Ambos secretos se cargan a mano, fuera de esta migración.
--
-- Todo el diseño es idempotente: el id del evento en Google es el uuid del
-- turno sin guiones, así que reenviar el mismo turno dos veces nunca duplica.

-- 1. Calendario propio "agendaMente" (scope calendar.app.created) y problema
-- de conexión visible para la profesional. Ninguna de las dos es editable por
-- authenticated: profesionales usa lista blanca de columnas para UPDATE
-- (20260920130000), y estas no se agregan.
alter table public.profesionales
  add column if not exists google_calendar_id text,
  add column if not exists google_calendar_problema text;

-- 2. Que la sincronización no ensucie el historial de auditoría: cada vez que
-- la Edge Function guarda google_event_id/google_sync_status, el trigger de
-- historial registraba un "Turno modificado" que la profesional nunca hizo.
-- Se ignoran las columnas google_* y, si no queda ningún cambio real, no se
-- inserta nada. Mismo cuerpo que el vigente salvo eso.
create or replace function public.registrar_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cambios jsonb := '{}'::jsonb;
  v_key text;
begin
  if not exists (select 1 from public.profesionales where id = old.profesional_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    insert into public.historial (profesional_id, hoja, accion, paciente_id, antes, cambios)
    values (old.profesional_id, tg_table_name, 'delete', old.paciente_id, to_jsonb(old), '{}'::jsonb);
    return old;
  elsif tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(to_jsonb(new)) loop
      if v_key like 'google\_%' then
        continue;
      end if;
      if (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
        v_cambios := v_cambios || jsonb_build_object(v_key, to_jsonb(new) -> v_key);
      end if;
    end loop;
    if v_cambios = '{}'::jsonb then
      return new;
    end if;
    insert into public.historial (profesional_id, hoja, accion, paciente_id, antes, cambios)
    values (old.profesional_id, tg_table_name, 'update', old.paciente_id, to_jsonb(old), v_cambios);
    return new;
  end if;
  return null;
end;
$$;

-- 3. Encolar un aviso a la Edge Function. net.http_post solo encola: el
-- request sale después del commit (si la transacción hace rollback, nunca
-- sale). p_accion: 'sync' (crear/actualizar/borrar-si-cancelado según el
-- estado actual del turno) o 'delete' (el turno ya no existe).
create or replace function public.encolar_sync_google(p_turno_id uuid, p_accion text, p_profesional_id uuid)
returns void
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_secreto text;
begin
  select decrypted_secret into v_secreto
  from vault.decrypted_secrets
  where name = 'sync_google_secret';

  if v_secreto is null then
    perform public.notificar_error('encolar_sync_google', 'falta el secret sync_google_secret en Vault');
    return;
  end if;

  perform net.http_post(
    url := 'https://rtkllwucobddekdkfoux.supabase.co/functions/v1/sync-turno-google',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agendamente-sync', v_secreto
    ),
    body := jsonb_build_object('accion', p_accion, 'turnoId', p_turno_id, 'profesionalId', p_profesional_id)
  );
end;
$$;

-- 4. Triggers sobre turnos.
-- 4a. BEFORE UPDATE: un cambio que afecta al evento lo deja 'pendiente' hasta
-- que la Edge Function confirme. Así el cron de reintentos también levanta
-- lo que se haya perdido en el camino.
create or replace function public.turno_marcar_pendiente_google()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.fecha is distinct from old.fecha
     or new.hora is distinct from old.hora
     or new.estado is distinct from old.estado
     or new.paciente_id is distinct from old.paciente_id then
    new.google_sync_status := 'pendiente';
  end if;
  return new;
end;
$$;

create trigger trg_turnos_google_pendiente
before update on public.turnos
for each row execute function public.turno_marcar_pendiente_google();

-- 4b. AFTER: encolar el aviso, solo si la profesional tiene Google conectado
-- (las cuentas sin conectar no generan ningún request). En UPDATE, solo si
-- cambió algo que se ve en el evento — la Edge Function escribe únicamente
-- columnas google_*, así que esto también corta cualquier loop.
create or replace function public.turno_encolar_sync_google()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profesional_id uuid := case when tg_op = 'DELETE' then old.profesional_id else new.profesional_id end;
begin
  if not exists (select 1 from public.google_calendar_tokens where profesional_id = v_profesional_id) then
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.encolar_sync_google(old.id, 'delete', old.profesional_id);
  elsif tg_op = 'INSERT' then
    perform public.encolar_sync_google(new.id, 'sync', new.profesional_id);
  elsif new.fecha is distinct from old.fecha
     or new.hora is distinct from old.hora
     or new.estado is distinct from old.estado
     or new.paciente_id is distinct from old.paciente_id then
    perform public.encolar_sync_google(new.id, 'sync', new.profesional_id);
  end if;
  return null;
end;
$$;

create trigger trg_turnos_sync_google
after insert or update or delete on public.turnos
for each row execute function public.turno_encolar_sync_google();

-- 4c. Si cambia el nombre/apellido de un paciente, cambian las iniciales del
-- título de sus eventos futuros.
create or replace function public.paciente_encolar_sync_google()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if not exists (select 1 from public.google_calendar_tokens where profesional_id = new.profesional_id) then
    return null;
  end if;
  for r in
    select t.id from public.turnos t
    where t.paciente_id = new.id and t.fecha >= current_date
  loop
    perform public.encolar_sync_google(r.id, 'sync', new.profesional_id);
  end loop;
  return null;
end;
$$;

create trigger trg_pacientes_sync_google
after update of nombre, apellido on public.pacientes
for each row
when (old.nombre is distinct from new.nombre or old.apellido is distinct from new.apellido)
execute function public.paciente_encolar_sync_google();

-- 5. Al conectar (o reconectar): mandar todos los turnos de hoy en adelante,
-- cualquiera sea su estado (los cancelados se resuelven como borrado, y un
-- 404 de Google es inocuo). La invoca google-oauth-callback.
create or replace function public.encolar_backfill_google(p_profesional_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select t.id from public.turnos t
    where t.profesional_id = p_profesional_id and t.fecha >= current_date
    order by t.fecha, t.hora
    limit 1000
  loop
    perform public.encolar_sync_google(r.id, 'sync', p_profesional_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 6. Reintentos: ahora cada hora, con el secreto nuevo (el anterior,
-- service_role_key_para_cron, estaba mal cargado en Vault y el cron fallaba
-- con 401 desde el día uno). Levanta 'error' y también 'pendiente' (un aviso
-- que se perdió en el camino) de ayer en adelante — reenviar uno que justo
-- está en curso es inofensivo, todo es idempotente.
create or replace function public.procesar_reintentos_google_calendar()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select t.id, t.profesional_id
    from public.turnos t
    join public.profesionales pr on pr.id = t.profesional_id
    join public.google_calendar_tokens g on g.profesional_id = t.profesional_id
    where t.google_sync_status in ('error', 'pendiente')
      and t.fecha >= current_date - 1
      and pr.estado_suscripcion in ('trial', 'activa')
    limit 200
  loop
    begin
      perform public.encolar_sync_google(r.id, 'sync', r.profesional_id);
    exception when others then
      perform public.notificar_error('cron_reintentos_google_calendar', 'turno ' || r.id || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

select cron.unschedule('agendamente-reintentos-google-calendar');
select cron.schedule('agendamente-reintentos-google-calendar', '20 * * * *', $$select public.procesar_reintentos_google_calendar();$$);

-- 7. `state` del OAuth: un nonce de un solo uso en vez del JWT de la sesión
-- (que viajaba en la URL de Google y quedaba en el historial del navegador).
create table if not exists public.google_oauth_estados (
  nonce text primary key,
  profesional_id uuid not null references public.profesionales(id) on delete cascade,
  creado_at timestamptz not null default now()
);
alter table public.google_oauth_estados enable row level security;

-- Sin parámetro a propósito: usa auth.uid(), nunca un id que venga del cliente.
create or replace function public.crear_estado_oauth_google()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_nonce text := encode(gen_random_bytes(32), 'hex');
begin
  if auth.uid() is null then
    raise exception 'no autenticada';
  end if;
  delete from public.google_oauth_estados where creado_at < now() - interval '10 minutes';
  insert into public.google_oauth_estados (nonce, profesional_id) values (v_nonce, auth.uid());
  return v_nonce;
end;
$$;

create or replace function public.consumir_estado_oauth_google(p_nonce text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profesional_id uuid;
begin
  delete from public.google_oauth_estados
  where nonce = p_nonce
  returning case when creado_at > now() - interval '10 minutes' then profesional_id end
  into v_profesional_id;
  return v_profesional_id;
end;
$$;

-- 8. Grants. El schema public da EXECUTE a anon/authenticated por default en
-- toda función nueva — hay que revocar explícito (ver CLAUDE.md).
revoke execute on function public.encolar_sync_google(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.turno_marcar_pendiente_google() from public, anon, authenticated;
revoke execute on function public.turno_encolar_sync_google() from public, anon, authenticated;
revoke execute on function public.paciente_encolar_sync_google() from public, anon, authenticated;
revoke execute on function public.encolar_backfill_google(uuid) from public, anon, authenticated;
revoke execute on function public.procesar_reintentos_google_calendar() from public, anon, authenticated;
revoke execute on function public.consumir_estado_oauth_google(text) from public, anon, authenticated;
revoke execute on function public.crear_estado_oauth_google() from public, anon;
grant execute on function public.encolar_backfill_google(uuid) to service_role;
grant execute on function public.consumir_estado_oauth_google(text) to service_role;
grant execute on function public.crear_estado_oauth_google() to authenticated;
