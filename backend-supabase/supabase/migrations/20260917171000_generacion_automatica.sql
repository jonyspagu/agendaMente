-- Generación automática de cobros mensuales y turnos recurrentes, corriendo
-- sola vía pg_cron (sin esto, dependería de que alguien abra la app o corra
-- un script a mano — no sirve para un producto multi-tenant self-service).
-- Réplica de procesarCobrosMensualesVencidos/procesarTurnosRecurrentes de
-- Código.js:202-330, con dos diferencias deliberadas: se filtra por
-- profesional_id (acá sí es multi-tenant) y por suscripción activa.
create extension if not exists pg_cron;

-- Réplica exacta de sumarUnMes() del frontend: suma un mes calendario con
-- clamp de fin de mes (31 ene + 1 mes = 28/29 feb, no "3 de marzo" como
-- haría un naive `date + interval '1 month'`).
create or replace function public.sumar_un_mes(p_fecha date)
returns date
language plpgsql
immutable
as $$
declare
  v_primer_dia_prox date := (date_trunc('month', p_fecha) + interval '1 month')::date;
  v_ultimo_dia_prox date := (v_primer_dia_prox + interval '1 month' - interval '1 day')::date;
begin
  return v_primer_dia_prox + (least(extract(day from p_fecha)::int, extract(day from v_ultimo_dia_prox)::int) - 1);
end;
$$;

create or replace function public.procesar_cobros_mensuales_vencidos()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_referencia date;
  v_max_cobro date;
  v_proxima date;
  v_iter int;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  for r in
    select p.id, p.profesional_id, p.desde, p.precio
    from public.pacientes p
    join public.profesionales pr on pr.id = p.profesional_id
    where p.tipo_pago = 'mensual'
      and p.desde is not null
      and p.precio <> 0
      and pr.estado_suscripcion in ('trial', 'activa')
  loop
    begin
      v_referencia := r.desde;

      select max(fecha) into v_max_cobro from public.cobros where paciente_id = r.id;
      if v_max_cobro is not null and v_max_cobro > v_referencia then
        v_referencia := v_max_cobro;
      end if;

      v_iter := 0;
      loop
        v_iter := v_iter + 1;
        exit when v_iter > 24;
        v_proxima := public.sumar_un_mes(v_referencia);
        exit when v_proxima > v_hoy;

        insert into public.cobros (profesional_id, paciente_id, fecha, monto, estado)
        values (r.profesional_id, r.id, v_proxima, r.precio, 'pendiente');

        v_referencia := v_proxima;
      end loop;
    exception when others then
      perform public.notificar_error('cron_cobros_mensuales', 'paciente ' || r.id || ': ' || sqlerrm);
    end;
  end loop;
end;
$$;

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
            and estado <> 'cancelado'
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

-- Sin este revoke, cualquier usuario autenticado podría invocar estas
-- funciones por RPC — procesan TODOS los tenants, no solo el propio.
-- (revocar solo de PUBLIC no alcanza: el schema public tiene default
-- privileges que dan EXECUTE a anon/authenticated en toda función nueva.)
revoke execute on function public.procesar_cobros_mensuales_vencidos() from public, anon, authenticated;
revoke execute on function public.procesar_turnos_recurrentes() from public, anon, authenticated;
grant execute on function public.procesar_cobros_mensuales_vencidos() to postgres;
grant execute on function public.procesar_turnos_recurrentes() to postgres;

select cron.schedule('agendamente-cobros-mensuales', '0 6 * * *', $$select public.procesar_cobros_mensuales_vencidos();$$);
select cron.schedule('agendamente-turnos-recurrentes', '5 6 * * *', $$select public.procesar_turnos_recurrentes();$$);
