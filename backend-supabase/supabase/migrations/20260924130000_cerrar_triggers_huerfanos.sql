-- Revisión de seguridad (2026-09-24): handle_new_user() y registrar_historial()
-- son funciones de trigger (leen NEW/OLD/TG_OP, que solo existen dentro de un
-- trigger real) y nunca recibieron el revoke explícito que sí se le puso a
-- todas las demás funciones nuevas del schema public.
--
-- No es explotable hoy: invocarlas directo por RPC (sb.rpc('handle_new_user'))
-- falla igual, porque Postgres no deja usar NEW/OLD fuera de un trigger — el
-- error llega antes de que el insert/borrado pase. Pero no hay que confiar en
-- ese detalle de implementación: se cierra explícito, mismo criterio que el
-- resto del repo (¿por qué el resto de las funciones sí tiene este revoke y
-- estas dos no? — sin motivo real, quedaron afuera por creación).
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.registrar_historial() from public, anon, authenticated;
