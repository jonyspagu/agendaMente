-- Soporte para encriptar la historia clínica en el navegador. Ninguna de
-- estas columnas revela la clave de datos sin la contraseña real o el código
-- de recuperación real (que nunca se guardan acá ni en ningún otro lado) —
-- ese es el punto: ni con acceso total a esta tabla se puede leer una nota.
alter table public.profesionales
  add column salt_password text,
  add column salt_recovery text,
  add column data_key_wrapped_password text,
  add column data_key_wrapped_recovery text;
