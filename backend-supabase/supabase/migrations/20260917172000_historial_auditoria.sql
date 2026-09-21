-- Historial de auditoría: hoy la tabla existe y el frontend la lee, pero
-- nada escribe ahí (funcionalidad muerta desde la migración a Supabase).
-- Se repone vía trigger (no desde el frontend) para que sea a prueba de
-- manipulación: ni el propio profesional puede reescribir su historial.
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

create trigger trg_historial_turnos
  after update or delete on public.turnos
  for each row execute function public.registrar_historial();

create trigger trg_historial_cobros
  after update or delete on public.cobros
  for each row execute function public.registrar_historial();

-- Antes: "for all" dejaba que el propio usuario insertara/editara/borrara su
-- historial directamente (spoofable). Ahora el trigger lo escribe solo, de
-- forma tamper-resistant (security definer) — al usuario le queda solo leer.
drop policy "historial: solo su consultorio" on public.historial;

create policy "historial: lectura de su consultorio"
  on public.historial for select
  using (profesional_id = auth.uid());
