# Contrato de API: Frontend ↔ Apps Script Web App

Este es el único "contrato de interfaz" real del proyecto: la llamada HTTP entre `index.html` y el Web App de Apps Script. Documentarlo (tal como el frontend lo consume hoy) es prerequisito para que la auditoría pueda comparar "lo que el frontend espera" contra "lo que el backend realmente hace" una vez clonado vía clasp.

## Request (`apiCall`, `index.html:1286-1295`)

```
POST {API_URL}
Content-Type: text/plain;charset=utf-8

{
  "sheet": "Pacientes" | "Turnos" | "Cobros",
  "action": "create" | "update" | "delete",
  "id": <number, solo para update/delete>,
  "data": { ...campos según CAMPOS_PACIENTE / CAMPOS_TURNO / CAMPOS_COBRO },
  "clave": <string, contraseña de sesión compartida>
}
```

Nota: se usa `Content-Type: text/plain` (no `application/json`) — patrón típico para evitar el preflight CORS de Apps Script Web Apps. Cualquier cambio de backend debe preservar esto o el frontend dejará de poder llamarlo.

## Response esperada (contrato inferido del lado del frontend)

```
{
  "ok": true,
  "id": <number>,           // requerido en creaciones — ES EL CAMPO BAJO AUDITORÍA
  "pacientes": [...],       // dataset completo o parcial, según acción
  "turnos": [...],
  "cobros": [...]
}
```

En error: `{ "ok": false, "error": "<mensaje>" }` — el frontend hace `throw new Error(json.error || "Error desconocido del backend")` (línea 1293).

## Puntos de contrato que la auditoría debe verificar contra el backend real

1. **Creación de Paciente** (`sheet: "Pacientes", action: "create"`): ¿el backend garantiza que `id` en la respuesta corresponde exactamente al valor ya escrito y "flusheado" en el Sheet? ¿Puede devolver `ok: true` con un `id` vacío o no persistido?
2. **Lista `pacientes` en la respuesta**: ¿siempre incluye al paciente recién creado con su ID correcto, o puede haber una condición de carrera donde la lectura para armar la respuesta ocurra antes de que la escritura sea visible (falta de `flush()`, Principio III de la constitución)?
3. **Creación de Turno** (`sheet: "Turnos", action: "create"`): ¿el backend valida que `data.pacienteId` corresponda a un paciente existente antes de guardar, o guarda cualquier valor recibido sin validar?
4. **Símbolo de error**: ¿el backend siempre devuelve `ok: false` + `error` ante un fallo, o hay casos donde devuelve `ok: true` con datos parcialmente inválidos (que es el patrón que el frontend maneja peor, según `data-model.md`)?

Este contrato se usa como checklist directo durante la revisión del código en `backend-appsscript/` (Fase de tareas/implementación, fuera de este documento).
