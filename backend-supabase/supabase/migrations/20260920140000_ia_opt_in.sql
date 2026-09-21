-- "Pulir con IA" pasa a ser opt-in por cuenta: apagada por defecto, y solo se
-- activa tras un aviso explícito (se guarda cuándo se aceptó).
alter table public.profesionales
  add column if not exists ia_activada boolean not null default false,
  add column if not exists ia_consentimiento_at timestamptz;

grant update (ia_activada, ia_consentimiento_at) on public.profesionales to authenticated;
