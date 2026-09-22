-- "Pulir con IA" se retira del producto (la clave de Gemini es de nivel
-- gratuito: Google puede usar lo enviado para mejorar sus productos, no apto
-- para datos clínicos). Las columnas quedan por si se reincorpora con un plan
-- de pago, pero ya nadie puede activarla desde la API.
revoke update (ia_activada, ia_consentimiento_at) on public.profesionales from authenticated;
