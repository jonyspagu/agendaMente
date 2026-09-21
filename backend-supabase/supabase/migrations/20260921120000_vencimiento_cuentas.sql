-- Cobro manual (Mercado Pago / transferencia): `trial_termina` funciona como
-- "acceso hasta" tanto para la prueba como para las cuentas pagas. Cuando pasa
-- esa fecha la cuenta pasa a 'vencida': la app la bloquea (deja descargar los
-- datos) y los cron de generación (cobros/turnos) dejan de correr para ella.
-- Al recibir un pago se reactiva con backend-supabase/admin/activar_cuenta.sql.

create or replace function public.vencer_cuentas()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  n integer;
begin
  update public.profesionales
     set estado_suscripcion = 'vencida'
   where estado_suscripcion in ('trial', 'activa')
     and trial_termina < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Default privileges de public dan EXECUTE a anon/authenticated: revocar explícito.
revoke execute on function public.vencer_cuentas() from public, anon, authenticated;

select cron.schedule('agendamente-vencer-cuentas', '55 5 * * *', $$select public.vencer_cuentas();$$);
