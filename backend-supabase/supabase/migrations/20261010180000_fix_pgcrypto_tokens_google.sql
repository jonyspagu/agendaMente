-- Bug encontrado en la primera prueba real contra Google (2026-10-10):
-- guardar_tokens_google() y obtener_tokens_google() tenían
-- `set search_path = public, vault`, pero en Supabase pgcrypto está instalado
-- en el schema `extensions`, así que pgp_sym_encrypt/pgp_sym_decrypt no se
-- encontraban ("function pgp_sym_encrypt(text, text) does not exist") y la
-- conexión con Google Calendar fallaba al guardar los tokens. Nunca había
-- saltado porque nadie había autorizado una cuenta real hasta ahora.
-- Mismo cuerpo que en 20260924120000; solo cambia el search_path.

create or replace function public.guardar_tokens_google(
  p_profesional_id uuid,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_calendar_id text default 'primary'
)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_clave text;
begin
  select decrypted_secret into v_clave
  from vault.decrypted_secrets
  where name = 'google_tokens_encryption_key';

  if v_clave is null then
    raise exception 'google_tokens_encryption_key no está configurado en Vault';
  end if;

  insert into public.google_calendar_tokens
    (profesional_id, access_token_enc, refresh_token_enc, expires_at, calendar_id, updated_at)
  values (
    p_profesional_id,
    pgp_sym_encrypt(p_access_token, v_clave),
    pgp_sym_encrypt(p_refresh_token, v_clave),
    p_expires_at,
    coalesce(p_calendar_id, 'primary'),
    now()
  )
  on conflict (profesional_id) do update set
    access_token_enc = excluded.access_token_enc,
    refresh_token_enc = excluded.refresh_token_enc,
    expires_at = excluded.expires_at,
    calendar_id = excluded.calendar_id,
    updated_at = now();
end;
$$;

create or replace function public.obtener_tokens_google(p_profesional_id uuid)
returns table (access_token text, refresh_token text, expires_at timestamptz, calendar_id text)
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_clave text;
begin
  select decrypted_secret into v_clave
  from vault.decrypted_secrets
  where name = 'google_tokens_encryption_key';

  if v_clave is null then
    raise exception 'google_tokens_encryption_key no está configurado en Vault';
  end if;

  return query
  select
    pgp_sym_decrypt(t.access_token_enc, v_clave),
    pgp_sym_decrypt(t.refresh_token_enc, v_clave),
    t.expires_at,
    t.calendar_id
  from public.google_calendar_tokens t
  where t.profesional_id = p_profesional_id;
end;
$$;

-- create or replace conserva los grants, pero se reafirman por las dudas
-- (default privileges de Supabase le dan EXECUTE a anon/authenticated).
revoke execute on function public.guardar_tokens_google(uuid, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.obtener_tokens_google(uuid) from public, anon, authenticated;
grant execute on function public.guardar_tokens_google(uuid, text, text, timestamptz, text) to service_role;
grant execute on function public.obtener_tokens_google(uuid) to service_role;
