# AgendaMente

CRM para consultorio de psicología (Pacientes/Turnos/Cobros/Historia clínica). Nació como la app de Guada (Lupita); está en transición a producto multi-tenant para vender a otras profesionales.

## Dos stacks en paralelo — no confundir

**Producción real (lo que usa Guada hoy):**
- `index.html` — frontend único, sin build, React vía CDN (`React.createElement`, sin JSX).
- `backend-appsscript/Código.js` — Google Apps Script sobre un Google Sheet (`SHEET_ID` en el archivo). Deployment activo: `AKfycby0AQpAfIDOSFCxM76I6J3PReHqHgdNulvhfNPLyGnMWTUrl77jijb-lbic2sah-8Ks7w` (el mismo URL que ya tiene `index.html` en `API_URL`).
- `backend-appsscript-test/Código.js` — clon idéntico salvo `SHEET_ID`/`CLAVE_ACCESO`, apunta a un Sheet de prueba separado. **Toda validación de backend pasa primero por acá.**
- `tests/test_backend_appsscript.py` — batería automática de regresión, corre solo contra el Sheet de test.

**Producto nuevo en construcción (todavía sin usuarios reales):**
- `frontend-supabase/index.html` — copia de `index.html` migrada a Supabase (mismo estilo sin JSX, mismo `apiCall(sheet, action, {id, data})` preservado).
- `backend-supabase/supabase/` — schema Postgres, RLS multi-tenant, triggers, `pg_cron`, Edge Functions. Proyecto Supabase real: `rtkllwucobddekdkfoux` (región `sa-east-1`).
- Nadie usa esto en serio todavía — ni Guada, ni ninguna clienta. Es el destino de la migración, no reemplaza nada de lo de arriba sin una decisión explícita de corte.

**Regla dura:** nunca tocar `index.html`/`backend-appsscript/Código.js`/el Google Sheet real como efecto colateral de trabajar en la versión Supabase. Son sistemas completamente aislados.

## Arquitectura de datos (ambos stacks comparten la forma)

Tablas/hojas: `Pacientes`, `Turnos`, `Cobros`, `Historial` (auditoría de ediciones/borrados de Turnos/Cobros), `Config`/`profesionales` (una fila por profesional: nombre, matrícula, plantillas de WhatsApp, marco teórico).

El frontend siempre trabaja en **camelCase** (`p.tipoPago`, `t.pacienteId`, `c.monto`). La traducción a snake_case (Postgres) o a lo que sea que tenga el Sheet vive solo en mappers puntuales (`pacienteADB`/`pacienteDeDB`, etc. en `frontend-supabase/index.html`) — el resto del componente no se entera del backend real.

`tipoPago`: `"sesion"` | `"mensual"`. Para `"mensual"` se cobra una vez por ciclo, no por turno — no confundir con un bug si no aparece un cobro por cada sesión.

## Encriptación de la historia clínica (solo en `frontend-supabase`)

Requisito explícito e innegociable: **ni Jonatan ni nadie con acceso a la base de datos puede leer la historia clínica** — es del cliente. Por eso `historia` se encripta en el navegador (Web Crypto, AES-GCM) antes de mandarse; la clave (`dataKey`) nunca sale de la pestaña.

- Al alta, se genera una `dataKey` envuelta dos veces: una con clave derivada de la contraseña (PBKDF2 + `salt_password`), otra con clave derivada de un código de recuperación que se muestra una única vez (`salt_recovery`). Ambas envolturas en `profesionales.data_key_wrapped_password` / `data_key_wrapped_recovery`.
- `_dataKey` es una variable de módulo (no React state, no localStorage) — vive solo en memoria de la pestaña actual. **Se resetea a `null` al cerrar sesión** (bug real encontrado y corregido: si no se limpia, la cuenta siguiente que loguea en la misma pestaña hereda la clave vieja).
- Recuperación de contraseña (Fase 2): si se resetea la contraseña vía el link de mail de Supabase, hay una pantalla dedicada que pide el código de recuperación para volver a envolver la `dataKey` con la contraseña nueva. Sin ese código, las notas viejas son irrecuperables — no hay atajo ni "empezar de cero" automático (decisión explícita, ver plan). **Verificado en vivo de punta a punta** (código incorrecto, código correcto + rotación de código nuevo, persistencia de una nota real tras el cambio de contraseña, login con la password vieja rechazado). Quirk conocido e inofensivo: a veces aparece de más la pantalla de "Desbloqueá tu historia clínica" pidiendo la contraseña una vez más justo después de recuperar el acceso — no rompe nada, solo hay que volver a tipearla.
- Mismo flujo, para una cuenta que **todavía no tiene dataKey** (primer login vía el link de "elegí tu contraseña", el caso del cutover de Guada): pantalla propia, sin pedir código (no hay nada que desenvolver todavía). **Bug real encontrado y corregido en pruebas**: ese mismo evento de auth "extra" del punto anterior, en este caso (sin dataKey), no era inofensivo — corría en paralelo el camino de login normal y terminaba generando una dataKey real envuelta con la contraseña vacía, *antes* de que la persona llegara a elegir la suya. El fix definitivo detecta el modo recuperación leyendo el hash de la URL de forma síncrona al montar el componente (un `ref` seteado recién dentro del handler del evento llegaba tarde, porque el evento problemático a veces dispara antes que `PASSWORD_RECOVERY`). Verificado en vivo de punta a punta con una cuenta simulando exactamente la situación de Guada.
- "Pulir con IA" (Gemini) se **sacó del producto** (decisión explícita) — ya no hay ninguna función que mande texto de la historia clínica a un servicio externo. Si en el futuro se reincorpora algo de IA sobre las notas, tiene que seguir el mismo principio: texto en claro solo transitorio en memoria, nunca persistido ni logueado.

## Supabase — puntos a tener en cuenta

- **Default privileges en el schema `public`** le dan `EXECUTE` a `anon`/`authenticated`/`service_role` en **toda función nueva automáticamente**. `revoke ... from public` NO alcanza — hay que revocar explícito de `anon, authenticated` en cada función sensible (cron jobs, `notificar_error`, etc.). Verificado empíricamente, no es un supuesto.
- Conexión directa a la base: `supabase db query --linked "<SQL>"` (o `-f archivo.sql`) — corre como superusuario, bypassea RLS por completo. Es la herramienta de trabajo de esta sesión, pero recordar que es exactamente la superficie que la encriptación de `historia` está diseñada para neutralizar.
- Cuentas de prueba: insertar directo en `auth.users` + `auth.identities` (evita los límites de envío de mail de confirmación). Columnas de texto que deben ser `''` y no `NULL` (si no, GoTrue tira `"Database error querying schema"` al loguear): `confirmation_token`, `recovery_token`, `email_change`, `email_change_token_new`, `email_change_token_current`, `phone_change`, `phone_change_token`, `reauthentication_token`.
- El mailer compartido de Supabase (plan gratuito) tiene un rate limit bajo — pocos mails por hora. Entra en juego al probar reset de contraseña real.
- Links de recuperación por mail a **Gmail** se rompen seguido: el escáner de seguridad de Gmail pre-visita el link automáticamente y consume el token de un solo uso antes de que la persona lo abra. Para probar de verdad, usar un mail que no sea Gmail (Outlook/iCloud/etc.).
- `redirectTo` de `resetPasswordForEmail` tiene que calzar EXACTO con `site_url`/`additional_redirect_urls` configurado en el proyecto (Authentication → URL Configuration del dashboard — el `config.toml` del repo es solo para `supabase start` local, `config push` no se debe correr sin revisar el diff completo primero: puede pisar configuración de auth/pooler/storage no relacionada).

## Convenciones de este repo

- Comentarios y nombres de función/variable en **español** en el código de la app (no en el código de infra/SQL, ahí mezclado con inglés estándar de Postgres).
- `frontend-supabase/index.html` es un solo archivo, sin build — cualquier edición se verifica con `node --check` sobre el contenido de los `<script>` extraídos (no hay linter propio).
- `CSV/` (datos reales de pacientes exportados para migraciones) está en `.gitignore` — nunca commitear.
- Nunca correr `git add`/`commit`/`push` sin que el usuario lo pida explícitamente.
- Todo cambio de backend se prueba primero contra el entorno de test (`backend-appsscript-test/` o cuentas de prueba en Supabase, siempre borradas al final) antes de tocar producción.
- Deploys a producción (Apps Script o lo que sea que despliegue Supabase) requieren confirmación explícita del usuario — el harness los bloquea automáticamente si no la hay.

## Estado (ver plan completo en `.claude/plans/` para el detalle de cada fase)

- ✅ Migración Fase A (auth multi-tenant, CRUD, RLS, encriptación de historia).
- ✅ Fase B (cobros mensuales y turnos recurrentes automáticos vía `pg_cron`, historial de auditoría vía trigger, alertas de error vía Edge Functions + Resend). La pieza de "Pulir con IA" (Gemini) que incluía originalmente se sacó después (ver arriba).
- ✅ Historial de auditoría y alertas de error ya deployados también al Apps Script de **producción** (beneficia a Guada hoy, aunque siga en el stack viejo).
- ✅ Datos reales de Guada migrados a Supabase — Pacientes/Turnos/Cobros/Config, **sin** `historia` (queda vacía a propósito) y sin que nadie se haya logueado todavía con su cuenta.
- ✅ Fase 2 (recuperación de contraseña con código) — verificada en vivo de punta a punta (ver detalle arriba). Lista para ofrecer a clientas reales.
- ✅ Cutover real de Guada a Supabase — código listo, verificado y **ya desplegado** a `app.agendamente.com.ar`. Falta: coordinar la sesión real con ella (elegir contraseña, guardar código de recuperación) y, aparte, migrar su `historia` real.
- ✅ Negocio — lanzamiento real: marca (isotipo "anillo + punto", desplegado como favicon en ambos sitios y también visible en el nav/footer de la landing, más acentos decorativos sutiles del mismo motivo en el hero/Confidencialidad/"Lo que resuelve"), landing (`sitio/index.html`) rediseñada 2026-09-23/24 con tono editorial sobrio (tipografía Newsreader, paleta marfil/navy, sin clichés de foto de stock), estructura reordenada (franja de confianza, "Lo que resuelve", capturas reales de la app, Confidencialidad como sección propia, precio estilo ticket), Términos/Privacidad escritos, precio $14.999/mes + 7 días gratis. Dominio `agendamente.com.ar`/`www`/`app.agendamente.com.ar` conectados y en producción (Cloudflare Workers con assets, `sitio-agendamente`/`app-agendamente`, SSL automático). Resend configurado como SMTP custom de Supabase Auth (dominio verificado, plantillas en español), verificado con mails reales. Alta self-service probada de punta a punta con el flujo público real, incluido el caso crítico de confirmar desde otro dispositivo (bug encontrado y corregido). Cobro **manual** (transferencia + activación vía `backend-supabase/admin/activar_cuenta.sql`) — decisión explícita de no integrar Mercado Pago para no bloquear el lanzamiento. Pendiente en la landing: sumar un testimonio real (queda placeholder retirado hasta tener la frase real de Guada).
- ⬜ Pendiente, no bloqueante: revisión de abogado de los dos placeholders legales que quedan (Res. 424/2020 arrepentimiento; art. 12 transferencia internacional de datos) — pospuesto sin fecha. ARCA: plan es inscribirse retroactivamente después de ~5 clientas reales (ver memoria `project_lanzamiento_gratis`).
- ⬜ Backlog (feature, no priorizado): Mercado Pago (cobro automático) si el volumen lo justifica más adelante.
- ⬜ Backlog (feature, no priorizado): sincronización con Google Calendar. Empezar por un solo sentido (AgendaMente → Google Calendar) es bastante más simple que ida y vuelta; requiere OAuth por profesional + guardar/renovar tokens + (a escala) verificación de la app ante Google. Esfuerzo comparable a Fase B, no es un ajuste chico.
- ⬜ Backlog (feature, no priorizado): migración automática de datos desde una planilla (hoy el "Cargá tus pacientes" de la landing dice "escribinos y vemos cómo pasar los que tenés" — proceso manual, uno a uno). Automatizarlo requeriría un importador de CSV con mapeo de columnas + validación (algo similar al script puntual que se usó para migrar los datos reales de Guada, pero genérico y con UI, no un script de una sola vez).
