-- Paleta de color elegida por cada profesional (pantalla de Configuración).
alter table public.profesionales
  add column if not exists tema text not null default 'azul'
  check (tema in ('azul', 'rosa', 'monocromo'));
