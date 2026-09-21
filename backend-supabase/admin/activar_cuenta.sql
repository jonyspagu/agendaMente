-- Operación manual de suscripciones (Mercado Pago / transferencia).
-- Se corre con:  npx --yes supabase db query --linked -f admin/activar_cuenta.sql
-- (o pegando cada bloque en el SQL Editor de Supabase). Reemplazá el mail.
-- NO expone datos clínicos: solo toca estado_suscripcion / trial_termina.

-- 1) Ver quién está cómo (sin datos de pacientes):
select u.email, p.nombre_profesional, p.estado_suscripcion, p.trial_termina
from public.profesionales p join auth.users u on u.id = p.id
order by p.trial_termina;

-- 2) Registrar un pago: activa la cuenta y suma 1 mes de acceso
--    (desde hoy, o desde la fecha actual de vencimiento si todavía no venció).
update public.profesionales p
   set estado_suscripcion = 'activa',
       trial_termina = greatest(now(), p.trial_termina) + interval '1 month'
  from auth.users u
 where u.id = p.id and u.email = 'REEMPLAZAR@mail.com'
returning u.email, p.estado_suscripcion, p.trial_termina;

-- 3) Cuenta fundadora / regalada (no vence):
-- update public.profesionales p set estado_suscripcion='activa', trial_termina='2099-12-31'
--   from auth.users u where u.id=p.id and u.email='REEMPLAZAR@mail.com';

-- 4) Cancelar una cuenta a pedido:
-- update public.profesionales p set estado_suscripcion='cancelada'
--   from auth.users u where u.id=p.id and u.email='REEMPLAZAR@mail.com';
