-- Cobro mensual por sesiones + estado de turno "cancelado_cobra" (2026-10).
-- Réplica de procesarCobrosMensualesVencidos de backend-appsscript/Código.js
-- (misma regla, mismo corte, misma ventana). Motivo: Guada reportó que el
-- cobro de sus pacientes mensuales tomaba una sola sesión (se cobraba
-- `precio` una vez por mes, y ella carga `precio` como valor por sesión) y
-- que lo de septiembre figuraba en octubre (se fechaba `desde` + N meses).
--
-- Regla nueva: un cobro por paciente mensual y por mes CERRADO, fechado el
-- último día de ese mes, por precio × sesiones que se cobran ('realizado' +
-- 'cancelado_cobra'). Se guarda la cantidad en cobros.sesiones. Si se marca
-- una sesión tarde, el cobro se recalcula — solo si sigue pendiente y con el
-- monto tal cual lo dejó el sistema (pagado o editado a mano: no se toca).
--
-- Diferencia deliberada con Apps Script: allá se recalcula en cada lectura;
-- acá, además del cron diario, un trigger sobre turnos recalcula en el acto
-- (sin eso, marcar tarde una sesión no se vería en el cobro hasta el día
-- siguiente). El frontend re-trae "cobros" después de tocar un turno
-- (TABLAS_AFECTADAS).

-- 1. Estado nuevo: el paciente canceló pero la sesión se cobra igual.
alter table public.turnos drop constraint turnos_estado_check;
alter table public.turnos add constraint turnos_estado_check
  check (estado in ('agendado', 'realizado', 'cancelado', 'cancelado_cobra'));

-- 2. Cuántas sesiones cobró el sistema en un cobro mensual (null = cobro por
--    sesión o cargado a mano).
alter table public.cobros add column sesiones integer;

-- 3. Crea o recalcula el cobro mensual de UN paciente para UN mes.
create or replace function public.sincronizar_cobro_mensual(p_paciente_id uuid, p_mes date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_mes date := date_trunc('month', p_mes)::date;
  v_fecha_cobro date := (date_trunc('month', p_mes) + interval '1 month' - interval '1 day')::date;
  v_pac record;
  v_cobro record;
  v_sesiones integer;
begin
  -- Solo meses cerrados, desde el inicio de la regla (sept 2026; los cobros
  -- de la regla vieja no se reprocesan) y dentro de los últimos 3 meses.
  if v_mes < date '2026-09-01' then return; end if;
  if v_mes >= date_trunc('month', v_hoy)::date then return; end if;
  if v_mes < (date_trunc('month', v_hoy) - interval '3 months')::date then return; end if;

  select p.id, p.profesional_id, p.precio, p.desde, p.tipo_pago into v_pac
  from public.pacientes p
  join public.profesionales pr on pr.id = p.profesional_id
  where p.id = p_paciente_id
    and pr.estado_suscripcion in ('trial', 'activa');
  if not found or v_pac.tipo_pago <> 'mensual' or coalesce(v_pac.precio, 0) = 0 then return; end if;
  if v_pac.desde is not null and v_mes < date_trunc('month', v_pac.desde)::date then return; end if;

  -- Serializa por paciente: cron y trigger (o dos turnos tocados a la vez)
  -- no pueden crear dos cobros para el mismo mes.
  perform pg_advisory_xact_lock(hashtext('cobro_mensual:' || p_paciente_id::text));

  select count(*) into v_sesiones
  from public.turnos
  where paciente_id = v_pac.id
    and fecha between v_mes and v_fecha_cobro
    and estado in ('realizado', 'cancelado_cobra');

  select id, estado, monto, sesiones into v_cobro
  from public.cobros
  where paciente_id = v_pac.id and fecha = v_fecha_cobro
  order by created_at
  limit 1;

  if not found then
    if v_sesiones > 0 then
      insert into public.cobros (profesional_id, paciente_id, fecha, monto, estado, sesiones)
      values (v_pac.profesional_id, v_pac.id, v_fecha_cobro, v_pac.precio * v_sesiones, 'pendiente', v_sesiones);
    end if;
    return;
  end if;

  if v_cobro.estado <> 'pendiente' or v_cobro.sesiones is null then return; end if;
  if v_cobro.monto <> v_pac.precio * v_cobro.sesiones then return; end if; -- editado a mano
  if v_cobro.sesiones = v_sesiones then return; end if;
  update public.cobros
  set monto = v_pac.precio * v_sesiones, sesiones = v_sesiones
  where id = v_cobro.id;
end;
$$;

-- 4. Cron diario: revisa los últimos 3 meses cerrados de cada paciente mensual.
create or replace function public.procesar_cobros_mensuales_vencidos()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  i integer;
begin
  for r in
    select p.id
    from public.pacientes p
    join public.profesionales pr on pr.id = p.profesional_id
    where p.tipo_pago = 'mensual'
      and p.precio <> 0
      and pr.estado_suscripcion in ('trial', 'activa')
  loop
    begin
      for i in 1..3 loop
        perform public.sincronizar_cobro_mensual(r.id, (date_trunc('month', v_hoy) - make_interval(months => i))::date);
      end loop;
    exception when others then
      perform public.notificar_error('cron_cobros_mensuales', 'paciente ' || r.id || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

-- 5. Recalcular en el acto al tocar un turno de un mes ya cerrado.
create or replace function public.turno_recalcular_cobro_mensual()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.sincronizar_cobro_mensual(old.paciente_id, old.fecha);
  end if;
  if tg_op = 'INSERT'
     or (tg_op = 'UPDATE' and (new.paciente_id is distinct from old.paciente_id
                               or date_trunc('month', new.fecha) <> date_trunc('month', old.fecha))) then
    perform public.sincronizar_cobro_mensual(new.paciente_id, new.fecha);
  end if;
  return null;
end;
$$;

create trigger trg_turnos_cobro_mensual
after insert or update of estado, fecha, paciente_id or delete on public.turnos
for each row execute function public.turno_recalcular_cobro_mensual();

-- 6. Turnos recurrentes: un "cancelado_cobra" tampoco ocupa el horario.
create or replace function public.procesar_turnos_recurrentes()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_freq int;
  v_ultimo record;
  v_proxima date;
  v_iter int;
  v_ya_existe boolean;
  v_ocupado boolean;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  for r in
    select p.id, p.profesional_id, p.frecuencia_dias
    from public.pacientes p
    join public.profesionales pr on pr.id = p.profesional_id
    where p.turno_recurrente = true
      and pr.estado_suscripcion in ('trial', 'activa')
  loop
    begin
      v_freq := coalesce(r.frecuencia_dias, 7);
      v_iter := 0;
      loop
        v_iter := v_iter + 1;
        exit when v_iter > 12;

        select fecha, hora into v_ultimo
        from public.turnos
        where paciente_id = r.id
        order by fecha desc, hora desc
        limit 1;

        exit when v_ultimo is null;       -- sin turno semilla, no genera nada
        exit when v_ultimo.fecha > v_hoy; -- ya hay uno futuro, listo por ahora

        v_proxima := v_ultimo.fecha + v_freq;

        select exists(
          select 1 from public.turnos
          where paciente_id = r.id and fecha = v_proxima and hora = v_ultimo.hora
        ) into v_ya_existe;

        select exists(
          select 1 from public.turnos
          where paciente_id <> r.id
            and profesional_id = r.profesional_id
            and fecha = v_proxima
            and hora = v_ultimo.hora
            and estado not in ('cancelado', 'cancelado_cobra')
        ) into v_ocupado;

        if not v_ya_existe and not v_ocupado then
          insert into public.turnos (profesional_id, paciente_id, fecha, hora, estado)
          values (r.profesional_id, r.id, v_proxima, v_ultimo.hora, 'agendado');
        end if;
      end loop;
    exception when others then
      perform public.notificar_error('cron_turnos_recurrentes', 'paciente ' || r.id || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

-- Grants: default privileges dan EXECUTE a anon/authenticated en toda
-- función nueva (ver CLAUDE.md). create or replace conserva los permisos de
-- las existentes, pero se reafirma igual.
revoke execute on function public.sincronizar_cobro_mensual(uuid, date) from public, anon, authenticated;
revoke execute on function public.turno_recalcular_cobro_mensual() from public, anon, authenticated;
revoke execute on function public.procesar_cobros_mensuales_vencidos() from public, anon, authenticated;
revoke execute on function public.procesar_turnos_recurrentes() from public, anon, authenticated;
