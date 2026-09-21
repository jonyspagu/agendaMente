-- Hasta ahora la policy de `profesionales` (for all sobre la propia fila) y los
-- privilegios por defecto de Supabase dejaban a cada profesional editar CUALQUIER
-- columna de su fila, incluidas estado_suscripcion y trial_termina (podía
-- extenderse la prueba gratis sola), y hasta borrar/reinsertar su fila.
-- RLS filtra FILAS, no columnas: acá se restringen las columnas por privilegios.

revoke all on public.profesionales from anon;
revoke insert, update, delete, truncate, references, trigger on public.profesionales from authenticated;

-- Solo estas columnas las puede escribir la propia profesional. estado_suscripcion
-- y trial_termina quedan de solo lectura (las cambia el backend: Mercado Pago /
-- service_role / superusuario). Una columna nueva NO queda editable salvo que se
-- agregue acá a propósito.
grant update (
  nombre_profesional, matricula, especialidad,
  plantilla_deuda, plantilla_simple, plantilla_aumento, marco_teorico,
  tema,
  salt_password, salt_recovery, data_key_wrapped_password, data_key_wrapped_recovery
) on public.profesionales to authenticated;
