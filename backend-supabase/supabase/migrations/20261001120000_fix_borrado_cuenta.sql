-- Bug encontrado al limpiar una cuenta de prueba (2026-10-01): una cuenta con
-- turnos o cobros NO se podía borrar. Al borrar auth.users → profesionales, el
-- on delete cascade borra sus turnos/cobros, eso dispara registrar_historial()
-- (AFTER DELETE), que intenta insertar en historial apuntando a una profesional
-- que ya no existe → viola historial_profesional_id_fkey y se revierte TODO el
-- borrado. Consecuencia real: imposible cumplir un pedido de baja de cuenta
-- (derecho de supresión, Ley 25.326) sin borrar a mano turnos/cobros primero.
--
-- Fix: si la profesional ya no existe, se está borrando la cuenta entera — no
-- hay nada que auditar (el propio historial se va a borrar en cascada igual).
-- El resto de la función queda idéntico a 20260917172000_historial_auditoria.
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
      if (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
        v_cambios := v_cambios || jsonb_build_object(v_key, to_jsonb(new) -> v_key);
      end if;
    end loop;
    insert into public.historial (profesional_id, hoja, accion, paciente_id, antes, cambios)
    values (old.profesional_id, tg_table_name, 'update', old.paciente_id, to_jsonb(old), v_cambios);
    return new;
  end if;
  return null;
end;
$$;

-- create or replace conserva los permisos existentes, pero se reafirma igual
-- (mismo criterio que 20260924130000_cerrar_triggers_huerfanos).
revoke execute on function public.registrar_historial() from public, anon, authenticated;
