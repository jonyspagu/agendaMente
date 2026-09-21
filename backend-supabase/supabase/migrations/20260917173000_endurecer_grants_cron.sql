-- Fix: el proyecto tiene default privileges en el schema public que otorgan
-- EXECUTE a anon/authenticated/service_role en TODA función nueva
-- automáticamente (confirmado por prueba real: revoke ... from public NO
-- alcanza, porque esos roles reciben el grant de forma explícita, no vía
-- PUBLIC). Sin este fix, cualquier usuario logueado podía invocar por RPC
-- las funciones de cron (que procesan TODOS los tenants) y notificar_error.
revoke execute on function public.procesar_cobros_mensuales_vencidos() from anon, authenticated;
revoke execute on function public.procesar_turnos_recurrentes() from anon, authenticated;
revoke execute on function public.notificar_error(text, text) from anon, authenticated;
