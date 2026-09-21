-- Esquema multi-tenant de AgendaMente.
-- Cada profesional (tenant) aísla sus datos vía Row Level Security, no vía
-- lógica de la app -- así una consulta mal escrita en el frontend nunca puede
-- filtrar datos de otro consultorio.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profesionales: reemplaza la hoja "Config" de hoy. id = mismo uuid que
-- auth.users, así que 1 fila = 1 login. Ya trae los campos de suscripción
-- para no tener que migrar el esquema de nuevo cuando se conecte el cobro.
-- ---------------------------------------------------------------------------
create table public.profesionales (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre_profesional text not null default '',
  matricula text not null default '',
  especialidad text not null default 'Psicología',
  plantilla_deuda text not null default '',
  plantilla_simple text not null default '',
  plantilla_aumento text not null default '',
  marco_teorico text not null default '',
  estado_suscripcion text not null default 'trial'
    check (estado_suscripcion in ('trial', 'activa', 'vencida', 'cancelada')),
  trial_termina timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- pacientes
-- ---------------------------------------------------------------------------
create table public.pacientes (
  id uuid primary key default gen_random_uuid(),
  profesional_id uuid not null references public.profesionales(id) on delete cascade,
  nombre text not null default '',
  apellido text not null default '',
  precio numeric not null default 0,
  telefono text not null default '',
  notas text not null default '',
  desde date,
  ultimo_aumento date,
  frecuencia_dias integer,
  meses_aumento integer not null default 6,
  historia jsonb not null default '[]'::jsonb,
  contacto_referencia text not null default '',
  parentesco_referencia text not null default '',
  telefono_referencia text not null default '',
  consentimiento_firmado boolean not null default false,
  fecha_consentimiento date,
  tipo_pago text not null default 'sesion' check (tipo_pago in ('sesion', 'mensual')),
  link_consentimiento text not null default '',
  turno_recurrente boolean not null default false,
  created_at timestamptz not null default now()
);

create index pacientes_profesional_id_idx on public.pacientes (profesional_id);

-- ---------------------------------------------------------------------------
-- turnos
-- ---------------------------------------------------------------------------
create table public.turnos (
  id uuid primary key default gen_random_uuid(),
  profesional_id uuid not null references public.profesionales(id) on delete cascade,
  paciente_id uuid not null references public.pacientes(id) on delete cascade,
  fecha date not null,
  hora time not null,
  estado text not null default 'agendado' check (estado in ('agendado', 'realizado', 'cancelado')),
  created_at timestamptz not null default now()
);

create index turnos_profesional_id_idx on public.turnos (profesional_id);
create index turnos_paciente_id_idx on public.turnos (paciente_id);

-- ---------------------------------------------------------------------------
-- cobros
-- ---------------------------------------------------------------------------
create table public.cobros (
  id uuid primary key default gen_random_uuid(),
  profesional_id uuid not null references public.profesionales(id) on delete cascade,
  paciente_id uuid not null references public.pacientes(id) on delete cascade,
  fecha date not null,
  monto numeric not null default 0,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'pagado')),
  created_at timestamptz not null default now()
);

create index cobros_profesional_id_idx on public.cobros (profesional_id);
create index cobros_paciente_id_idx on public.cobros (paciente_id);

-- ---------------------------------------------------------------------------
-- historial: auditoría de ediciones/eliminaciones de turnos y cobros (mismo
-- concepto que la hoja "Historial" del backend de Apps Script).
-- ---------------------------------------------------------------------------
create table public.historial (
  id uuid primary key default gen_random_uuid(),
  profesional_id uuid not null references public.profesionales(id) on delete cascade,
  fecha timestamptz not null default now(),
  hoja text not null check (hoja in ('turnos', 'cobros')),
  accion text not null check (accion in ('update', 'delete')),
  paciente_id uuid,
  antes jsonb not null default '{}'::jsonb,
  cambios jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index historial_profesional_id_idx on public.historial (profesional_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: cada profesional solo ve/edita sus propias filas.
-- ---------------------------------------------------------------------------
alter table public.profesionales enable row level security;
alter table public.pacientes enable row level security;
alter table public.turnos enable row level security;
alter table public.cobros enable row level security;
alter table public.historial enable row level security;

create policy "profesionales: solo su propia fila"
  on public.profesionales for all
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "pacientes: solo su consultorio"
  on public.pacientes for all
  using (profesional_id = auth.uid())
  with check (profesional_id = auth.uid());

create policy "turnos: solo su consultorio"
  on public.turnos for all
  using (profesional_id = auth.uid())
  with check (profesional_id = auth.uid());

create policy "cobros: solo su consultorio"
  on public.cobros for all
  using (profesional_id = auth.uid())
  with check (profesional_id = auth.uid());

create policy "historial: solo su consultorio"
  on public.historial for all
  using (profesional_id = auth.uid())
  with check (profesional_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Alta automática: al crear una cuenta en auth.users, se crea su fila en
-- profesionales con los defaults (incluido el trial de 7 días). Así el alta
-- self-service no necesita ninguna lógica extra en el frontend.
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profesionales (id)
  values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
