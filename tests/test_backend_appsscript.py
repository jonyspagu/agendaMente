#!/usr/bin/env python3
"""
Batería de pruebas automatizadas para el backend de Apps Script de AgendaMente.

CORRE EXCLUSIVAMENTE CONTRA EL SHEET DE TEST ("Consultorio online - TEST"),
vía la implementación de Apps Script en backend-appsscript-test/. Nunca toca
producción ni el Sheet real de Lupita.

Uso:
    python3 -u tests/test_backend_appsscript.py

(el -u es recomendado para ver el progreso en vivo si corre lento)

Requiere solo la librería estándar de Python (sin dependencias externas).
Todo dato que crea, lo borra al final (pase lo que pase, incluso si falla
un test a mitad de camino) — la limpieza nunca revienta el script aunque
algo haya fallado antes.

Cubre:
  1. CRUD completo de Pacientes, Turnos y Cobros.
  2. Regresión de los bugs corregidos: headers con mayúscula distinta
     (H1/H2), pacienteId inexistente rechazado (H3), IDs duplicados por
     escrituras concurrentes.
  3. H5: marcar un turno "realizado" dos veces no duplica el cobro.
  4. Tiempos de respuesta de cada operación, como referencia futura.

Si el backend está lento (Apps Script bajo carga, cuotas de Google, etc.),
algunos pasos pueden fallar por timeout — el script no se cae por eso, lo
reporta como una falla más y sigue, para no perder la limpieza final.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Implementación de TEST (backend-appsscript-test/), NUNCA la de producción.
TEST_URL = "https://script.google.com/macros/s/AKfycbwC7TW_XZa3ea0fXm7hwjAc05R75MiImb_qSfyKGeYtzNX_YhZOdFM3VWKluY0wOrF2gg/exec"
CLAVE = "Consul123"

# Prefijo inconfundible para todo dato de prueba, por si algo queda sin
# limpiar y hay que identificarlo a simple vista en el Sheet.
TAG = "ZZZ_TEST_AUTOMATIZADO"

MAX_HOPS = 8          # tope de saltos de redirect a seguir (Apps Script a veces "rebota" mientras la ejecución sigue corriendo)
HOP_TIMEOUT = 40      # timeout por salto, en segundos
TOTAL_TIMEOUT = 90    # tope total por request, en segundos
REINTENTOS = 2        # reintentos ante timeout/error de red antes de darse por vencido


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(NoRedirect)


def _hop(url, method="GET", body=None, timeout=HOP_TIMEOUT):
    headers = {"Content-Type": "text/plain;charset=utf-8"} if body is not None else {}
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        resp = _opener.open(req, timeout=timeout)
        return resp.getcode(), resp.read(), dict(resp.getheaders())
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def _request_una_vez(method, url, body=None):
    """Sigue la cadena de redirects de Apps Script (que puede rebotar varias
    veces si la ejecución todavía no terminó) hasta conseguir un JSON real,
    o hasta agotar el tiempo/saltos. Devuelve (json_o_None, segundos, error)."""
    t0 = time.monotonic()
    current_url, current_method, current_body = url, method, body
    for _hop_n in range(MAX_HOPS):
        if time.monotonic() - t0 > TOTAL_TIMEOUT:
            return None, time.monotonic() - t0, "timeout total excedido"
        try:
            code, content, headers = _hop(current_url, current_method, current_body)
        except Exception as e:  # noqa: BLE001 - cualquier fallo de red se reporta, no se propaga
            return None, time.monotonic() - t0, f"error de red: {e}"
        if code in (301, 302, 303, 307, 308):
            loc = headers.get("Location") or headers.get("location")
            if not loc:
                return None, time.monotonic() - t0, f"redirect sin Location (status {code})"
            current_url, current_method, current_body = loc, "GET", None
            continue
        if code == 200:
            try:
                return json.loads(content.decode("utf-8")), time.monotonic() - t0, None
            except json.JSONDecodeError:
                return None, time.monotonic() - t0, f"respuesta 200 no es JSON: {content[:200]!r}"
        return None, time.monotonic() - t0, f"status HTTP inesperado: {code}"
    return None, time.monotonic() - t0, f"se agotaron los {MAX_HOPS} saltos de redirect sin resolver"


def _request(method, url, body=None):
    """Como _request_una_vez, pero reintenta ante timeout/error de red (no
    ante errores de la aplicación, esos se devuelven tal cual)."""
    ultimo_err = None
    tiempo_total = 0.0
    for intento in range(REINTENTOS + 1):
        res, t, err = _request_una_vez(method, url, body)
        tiempo_total += t
        if res is not None or err is None:
            return res, tiempo_total, err
        ultimo_err = err
        if intento < REINTENTOS:
            time.sleep(2)
    return None, tiempo_total, ultimo_err


def api_get():
    return _request("GET", f"{TEST_URL}?clave={CLAVE}")


def api_post(sheet, action, id_=None, data=None):
    body = json.dumps({"sheet": sheet, "action": action, "id": id_, "data": data, "clave": CLAVE}).encode("utf-8")
    return _request("POST", TEST_URL, body)


# --------------------------------------------------------------------------
# Recolector de resultados
# --------------------------------------------------------------------------

class Resultados:
    def __init__(self):
        self.tests = []       # (nombre, ok, detalle)
        self.tiempos = {}     # operacion -> [segundos, ...]

    def registrar_tiempo(self, operacion, segundos):
        self.tiempos.setdefault(operacion, []).append(segundos)

    def check(self, nombre, ok, detalle=""):
        self.tests.append((nombre, ok, detalle))
        marca = "OK  " if ok else "FAIL"
        print(f"[{marca}] {nombre}" + (f" — {detalle}" if detalle else ""), flush=True)
        return ok

    def skip(self, nombre, motivo):
        self.tests.append((nombre, False, f"SALTEADO — {motivo}"))
        print(f"[SKIP] {nombre} — {motivo}", flush=True)

    def resumen(self):
        total = len(self.tests)
        fallidos = [t for t in self.tests if not t[1]]
        print("\n" + "=" * 70)
        print(f"RESULTADO: {total - len(fallidos)}/{total} tests OK")
        if fallidos:
            print(f"\n{len(fallidos)} FALLO(S)/SALTEADO(S):")
            for nombre, _ok, detalle in fallidos:
                print(f"  - {nombre}: {detalle}")
        if self.tiempos:
            print("\nTiempos de respuesta (segundos) — referencia de 'normal' a partir de hoy:")
            for op, valores in sorted(self.tiempos.items()):
                print(f"  {op:32s} n={len(valores):<3d} min={min(valores):6.2f}  avg={sum(valores)/len(valores):6.2f}  max={max(valores):6.2f}")
        print("=" * 70)
        return len(fallidos) == 0


# --------------------------------------------------------------------------
# Helpers de alto nivel (con timing automático)
# --------------------------------------------------------------------------

def crear(r, sheet, data, op_label=None):
    res, t, err = api_post(sheet, "create", data=data)
    r.registrar_tiempo(op_label or f"create_{sheet.lower()}", t)
    return res, err


def actualizar(r, sheet, id_, data, op_label=None):
    res, t, err = api_post(sheet, "update", id_=id_, data=data)
    r.registrar_tiempo(op_label or f"update_{sheet.lower()}", t)
    return res, err


def borrar(r, sheet, id_, op_label=None):
    res, t, err = api_post(sheet, "delete", id_=id_)
    r.registrar_tiempo(op_label or f"delete_{sheet.lower()}", t)
    return res, err


def leer(r, op_label="read_getAllData"):
    res, t, err = api_get()
    r.registrar_tiempo(op_label, t)
    return res, err


def leer_con_reintento(r, predicado, intentos=3, espera=2, op_label="read_getAllData"):
    """Relee hasta `intentos` veces, esperando `predicado(data)` sea verdad
    (por si hay un pequeño delay de consistencia entre escritura y lectura
    desde una request separada)."""
    data = None
    for i in range(intentos):
        data, err = leer(r, op_label)
        if data is not None and predicado(data):
            return data, err
        if i < intentos - 1:
            time.sleep(espera)
    return data, err if data is None else None


def buscar(lista, id_):
    return next((x for x in lista if _leer_id(x) == id_), None)


def _leer_id(obj):
    for k in obj.keys():
        if str(k).strip().lower() == "id":
            try:
                return int(obj[k])
            except (TypeError, ValueError):
                return obj[k]
    return None


def _leer_paciente_id(obj):
    for k in obj.keys():
        if str(k).strip().lower() == "pacienteid":
            try:
                return int(obj[k])
            except (TypeError, ValueError):
                return None
    return None


# --------------------------------------------------------------------------
# Suite de tests
# --------------------------------------------------------------------------

def main():
    r = Resultados()
    creados = {"Pacientes": set(), "Turnos": set(), "Cobros": set()}  # ids a limpiar al final

    def registrar_creado(sheet, id_):
        if id_ is not None:
            creados[sheet].add(id_)

    def marcar_borrado(sheet, id_):
        creados[sheet].discard(id_)  # discard nunca tira error si no está

    print(f"Corriendo contra: {TEST_URL}")
    print("(Sheet de test — nunca producción)\n")

    # --- Baseline: solo para confirmar que se puede leer el Sheet ---
    estado_inicial, err = leer(r, "read_baseline")
    if not r.check("Lectura inicial del Sheet de test", estado_inicial is not None, err):
        print("\nNo se pudo ni siquiera leer el Sheet de test — abortando el resto de la suite.")
        r.resumen()
        sys.exit(1)

    paciente_id = None
    turno_id = None
    cobro_id = None

    try:
        # ==================================================================
        # 1. CRUD Pacientes (y de paso, regresión H1: header con mayúscula
        #    distinta en Pacientes sigue asignando/leyendo el id bien)
        # ==================================================================
        res, err = crear(r, "Pacientes", {
            "nombre": TAG, "apellido": "paciente", "precio": 15000, "telefono": "000",
            "notas": "", "desde": "2026-01", "ultimoAumento": "", "frecuenciaDias": 7,
            "mesesAumento": 6, "historia": "[]", "contactoReferencia": "",
            "consentimientoFirmado": "NO", "fechaConsentimiento": "", "tipoPago": "sesion",
            "linkConsentimiento": ""
        })
        paciente_id = res.get("id") if res else None
        registrar_creado("Pacientes", paciente_id)
        r.check("Crear paciente", res is not None and res.get("ok") is True and isinstance(paciente_id, int), err or f"id devuelto: {paciente_id}")

        if paciente_id is None:
            r.skip("H1/H2 — paciente releído tiene id numérico válido", "no se pudo crear el paciente")
            r.skip("Actualizar paciente (teléfono) y releer", "no se pudo crear el paciente")
        else:
            data, err = leer_con_reintento(r, lambda d: buscar(d.get("pacientes", []), paciente_id) is not None)
            paciente_leido = buscar(data.get("pacientes", []), paciente_id) if data else None
            r.check(
                "H1/H2 — paciente releído tiene id numérico válido (tolera header con otra mayúscula)",
                paciente_leido is not None and _leer_id(paciente_leido) == paciente_id,
                f"paciente leído: {paciente_leido}"
            )

            actualizar(r, "Pacientes", paciente_id, {"telefono": "111-actualizado"})
            data, err2 = leer_con_reintento(r, lambda d: (buscar(d.get("pacientes", []), paciente_id) or {}).get("telefono") == "111-actualizado")
            paciente_leido = buscar(data.get("pacientes", []), paciente_id) if data else None
            r.check(
                "Actualizar paciente (teléfono) y releer",
                paciente_leido is not None and str(paciente_leido.get("telefono")) == "111-actualizado",
                f"paciente leído: {paciente_leido}"
            )

        # ==================================================================
        # 2. CRUD Turnos (usando el paciente recién creado)
        # ==================================================================
        if paciente_id is None:
            for nombre in (
                "Crear turno vinculado a paciente válido",
                "H1/H2 — turno releído tiene pacienteId numérico correcto",
                "Actualizar turno (estado) y releer",
                "Borrar turno y confirmar que ya no aparece",
            ):
                r.skip(nombre, "no hay paciente válido para vincular (falló su creación)")
        else:
            res, err = crear(r, "Turnos", {"pacienteId": paciente_id, "fecha": "2099-01-01", "hora": "10:00", "estado": "agendado"})
            turno_id = res.get("id") if res else None
            registrar_creado("Turnos", turno_id)
            r.check("Crear turno vinculado a paciente válido", res is not None and res.get("ok") is True and isinstance(turno_id, int), err or f"id devuelto: {turno_id}")

            if turno_id is None:
                r.skip("H1/H2 — turno releído tiene pacienteId numérico correcto", "no se pudo crear el turno")
                r.skip("Actualizar turno (estado) y releer", "no se pudo crear el turno")
                r.skip("Borrar turno y confirmar que ya no aparece", "no se pudo crear el turno")
            else:
                data, err = leer_con_reintento(r, lambda d: buscar(d.get("turnos", []), turno_id) is not None)
                turno_leido = buscar(data.get("turnos", []), turno_id) if data else None
                r.check(
                    "H1/H2 — turno releído tiene pacienteId numérico correcto (tolera header 'pacienteid')",
                    turno_leido is not None and _leer_paciente_id(turno_leido) == paciente_id,
                    f"turno leído: {turno_leido}"
                )

                actualizar(r, "Turnos", turno_id, {"estado": "cancelado"})
                data, err2 = leer_con_reintento(r, lambda d: (buscar(d.get("turnos", []), turno_id) or {}).get("estado") == "cancelado")
                turno_leido = buscar(data.get("turnos", []), turno_id) if data else None
                r.check(
                    "Actualizar turno (estado) y releer",
                    turno_leido is not None and turno_leido.get("estado") == "cancelado",
                    f"turno leído: {turno_leido}"
                )

                borrar(r, "Turnos", turno_id)
                data, err2 = leer_con_reintento(r, lambda d: buscar(d.get("turnos", []), turno_id) is None)
                borrado_ok = data is not None and buscar(data.get("turnos", []), turno_id) is None
                r.check("Borrar turno y confirmar que ya no aparece", borrado_ok, err2 or "")
                if borrado_ok:
                    marcar_borrado("Turnos", turno_id)
                    turno_id = None

        # ==================================================================
        # 3. CRUD Cobros
        # ==================================================================
        if paciente_id is None:
            for nombre in (
                "Crear cobro vinculado a paciente válido",
                "Cobro releído tiene pacienteId numérico correcto",
                "Actualizar cobro (estado pagado) y releer",
                "Borrar cobro y confirmar que ya no aparece",
            ):
                r.skip(nombre, "no hay paciente válido para vincular (falló su creación)")
        else:
            res, err = crear(r, "Cobros", {"pacienteId": paciente_id, "fecha": "2099-01-02", "monto": 15000, "estado": "pendiente"})
            cobro_id = res.get("id") if res else None
            registrar_creado("Cobros", cobro_id)
            r.check("Crear cobro vinculado a paciente válido", res is not None and res.get("ok") is True and isinstance(cobro_id, int), err or f"id devuelto: {cobro_id}")

            if cobro_id is None:
                r.skip("Cobro releído tiene pacienteId numérico correcto", "no se pudo crear el cobro")
                r.skip("Actualizar cobro (estado pagado) y releer", "no se pudo crear el cobro")
                r.skip("Borrar cobro y confirmar que ya no aparece", "no se pudo crear el cobro")
            else:
                data, err = leer_con_reintento(r, lambda d: buscar(d.get("cobros", []), cobro_id) is not None)
                cobro_leido = buscar(data.get("cobros", []), cobro_id) if data else None
                r.check(
                    "Cobro releído tiene pacienteId numérico correcto",
                    cobro_leido is not None and _leer_paciente_id(cobro_leido) == paciente_id,
                    f"cobro leído: {cobro_leido}"
                )

                actualizar(r, "Cobros", cobro_id, {"estado": "pagado"})
                data, err2 = leer_con_reintento(r, lambda d: (buscar(d.get("cobros", []), cobro_id) or {}).get("estado") == "pagado")
                cobro_leido = buscar(data.get("cobros", []), cobro_id) if data else None
                r.check(
                    "Actualizar cobro (estado pagado) y releer",
                    cobro_leido is not None and cobro_leido.get("estado") == "pagado",
                    f"cobro leído: {cobro_leido}"
                )

                borrar(r, "Cobros", cobro_id)
                data, err2 = leer_con_reintento(r, lambda d: buscar(d.get("cobros", []), cobro_id) is None)
                borrado_ok = data is not None and buscar(data.get("cobros", []), cobro_id) is None
                r.check("Borrar cobro y confirmar que ya no aparece", borrado_ok, err2 or "")
                if borrado_ok:
                    marcar_borrado("Cobros", cobro_id)
                    cobro_id = None

        # ==================================================================
        # 4. H3 — pacienteId inexistente se rechaza sin guardar nada
        # ==================================================================
        data_antes, err = leer(r, "read_pre_h3")
        n_turnos_antes = len(data_antes.get("turnos", [])) if data_antes else None
        if data_antes is None:
            r.skip("H3 — crear turno con pacienteId inexistente es rechazado", "no se pudo leer el estado previo")
            r.skip("H3 — no se creó ninguna fila nueva en Turnos tras el rechazo", "no se pudo leer el estado previo")
        else:
            res, err = crear(r, "Turnos", {"pacienteId": 999999, "fecha": "2099-01-03", "hora": "10:00", "estado": "agendado"}, op_label="create_turno_rechazado_h3")
            r.check(
                "H3 — crear turno con pacienteId inexistente es rechazado (ok:false)",
                res is not None and res.get("ok") is False,
                f"respuesta: {res}, error de transporte: {err}"
            )
            data_despues, err2 = leer(r, "read_post_h3")
            n_turnos_despues = len(data_despues.get("turnos", [])) if data_despues else None
            r.check(
                "H3 — no se creó ninguna fila nueva en Turnos tras el rechazo",
                n_turnos_despues is not None and n_turnos_antes == n_turnos_despues,
                f"turnos antes: {n_turnos_antes}, después: {n_turnos_despues}"
            )

        # ==================================================================
        # 5. Concurrencia — dos creaciones simultáneas no duplican IDs
        # ==================================================================
        if paciente_id is None:
            r.skip("Concurrencia — dos creaciones simultáneas de Cobros responden ok", "no hay paciente válido")
            r.skip("Concurrencia — no se duplicó el ID ni la fila", "no hay paciente válido")
        else:
            payload_concurrente = {"pacienteId": paciente_id, "fecha": "2099-01-04", "monto": 5000, "estado": "pendiente"}
            with ThreadPoolExecutor(max_workers=2) as ex:
                f1 = ex.submit(crear, r, "Cobros", payload_concurrente, "create_cobro_concurrente")
                f2 = ex.submit(crear, r, "Cobros", payload_concurrente, "create_cobro_concurrente")
                (res_a, err_a), (res_b, err_b) = f1.result(), f2.result()

            data, err = leer_con_reintento(
                r,
                lambda d: len([c for c in d.get("cobros", []) if _leer_paciente_id(c) == paciente_id and c.get("fecha") == "2099-01-04"]) >= 1,
                op_label="read_post_concurrencia"
            )
            cobros_concurrentes = [c for c in data.get("cobros", []) if _leer_paciente_id(c) == paciente_id and c.get("fecha") == "2099-01-04"] if data else []
            for c in cobros_concurrentes:
                registrar_creado("Cobros", _leer_id(c))
            ok_ids = bool((res_a or {}).get("ok")) and bool((res_b or {}).get("ok"))
            r.check(
                "Concurrencia — dos creaciones simultáneas de Cobros responden ok",
                ok_ids,
                f"respuesta A: {res_a}, respuesta B: {res_b}"
            )
            r.check(
                "Concurrencia — no se duplicó el ID ni la fila (queda exactamente 1 cobro)",
                len(cobros_concurrentes) == 1,
                f"cobros encontrados para esa fecha/paciente: {cobros_concurrentes}"
            )

            # Chequeo general de que no haya ningún id duplicado en ninguna hoja
            if data is not None:
                for sheet_key in ("pacientes", "turnos", "cobros"):
                    ids_validos = [i for i in (_leer_id(x) for x in data.get(sheet_key, [])) if i is not None]
                    r.check(
                        f"Sin IDs duplicados en {sheet_key}",
                        len(ids_validos) == len(set(ids_validos)),
                        f"ids: {ids_validos}"
                    )

        # ==================================================================
        # 6. H5 — marcar turno "realizado" dos veces no duplica el cobro
        # ==================================================================
        if paciente_id is None:
            r.skip("H5 — marcar 'realizado' dos veces seguidas genera un solo cobro", "no hay paciente válido")
        else:
            res, err = crear(r, "Turnos", {"pacienteId": paciente_id, "fecha": "2099-01-06", "hora": "11:00", "estado": "agendado"})
            turno_h5_id = res.get("id") if res else None
            registrar_creado("Turnos", turno_h5_id)
            r.check("H5 — crear turno para el escenario de 'realizado' x2", res is not None and res.get("ok") is True, err or f"id: {turno_h5_id}")

            if turno_h5_id is None:
                r.skip("H5 — marcar 'realizado' dos veces seguidas genera un solo cobro", "no se pudo crear el turno de prueba")
            else:
                # Simula lo que hace el frontend al marcar "realizado": update
                # del turno + create del cobro correspondiente. Repetido dos
                # veces seguidas (mismo turno, ya "realizado" la 2da vez).
                actualizar(r, "Turnos", turno_h5_id, {"estado": "realizado"}, op_label="update_turno_realizado")
                crear(r, "Cobros", {"pacienteId": paciente_id, "fecha": "2099-01-06", "monto": 15000, "estado": "pendiente"}, op_label="create_cobro_por_realizado")
                actualizar(r, "Turnos", turno_h5_id, {"estado": "realizado"}, op_label="update_turno_realizado")
                crear(r, "Cobros", {"pacienteId": paciente_id, "fecha": "2099-01-06", "monto": 15000, "estado": "pendiente"}, op_label="create_cobro_por_realizado")

                data, err = leer_con_reintento(
                    r,
                    lambda d: len([c for c in d.get("cobros", []) if _leer_paciente_id(c) == paciente_id and c.get("fecha") == "2099-01-06"]) >= 1,
                    op_label="read_post_h5"
                )
                cobros_h5 = [c for c in data.get("cobros", []) if _leer_paciente_id(c) == paciente_id and c.get("fecha") == "2099-01-06"] if data else []
                for c in cobros_h5:
                    registrar_creado("Cobros", _leer_id(c))
                r.check(
                    "H5 — marcar 'realizado' dos veces seguidas genera un solo cobro",
                    len(cobros_h5) == 1,
                    f"cobros encontrados para ese turno: {cobros_h5}"
                )

        # ==================================================================
        # 7. Borrar Pacientes (feature nueva de UI: botón "Eliminar" en
        #    Pacientes) — incluye el caso con turnos/cobros vinculados, que
        #    es justo el escenario que dispara el aviso en el frontend antes
        #    de confirmar. El conteo/aviso en sí es lógica de frontend (no
        #    expuesta por la API), así que acá solo se verifica el
        #    comportamiento del backend: el delete de un paciente con
        #    vínculos igual se ejecuta, y los turnos/cobros quedan huérfanos
        #    sin romper nada (ya cubierto por H3/H4 que toleran pacienteId
        #    sin match).
        # ==================================================================
        res, err = crear(r, "Pacientes", {
            "nombre": TAG, "apellido": "borrar_simple", "precio": 12000, "telefono": "000",
            "notas": "", "desde": "2026-01", "ultimoAumento": "", "frecuenciaDias": 7,
            "mesesAumento": 6, "historia": "[]", "contactoReferencia": "",
            "consentimientoFirmado": "NO", "fechaConsentimiento": "", "tipoPago": "sesion",
            "linkConsentimiento": ""
        })
        paciente_borrar_id = res.get("id") if res else None
        registrar_creado("Pacientes", paciente_borrar_id)
        r.check("Borrar Pacientes — crear paciente sin vínculos para el caso simple", res is not None and res.get("ok") is True, err or f"id: {paciente_borrar_id}")

        if paciente_borrar_id is None:
            r.skip("Borrar paciente sin turnos/cobros vinculados", "no se pudo crear el paciente de prueba")
        else:
            borrar(r, "Pacientes", paciente_borrar_id)
            data, err2 = leer_con_reintento(r, lambda d: buscar(d.get("pacientes", []), paciente_borrar_id) is None)
            borrado_ok = data is not None and buscar(data.get("pacientes", []), paciente_borrar_id) is None
            r.check("Borrar paciente sin turnos/cobros vinculados", borrado_ok, err2 or "")
            if borrado_ok:
                marcar_borrado("Pacientes", paciente_borrar_id)

        # Caso con vínculos: paciente + un turno + un cobro asociados.
        res, err = crear(r, "Pacientes", {
            "nombre": TAG, "apellido": "borrar_con_vinculos", "precio": 12000, "telefono": "000",
            "notas": "", "desde": "2026-01", "ultimoAumento": "", "frecuenciaDias": 7,
            "mesesAumento": 6, "historia": "[]", "contactoReferencia": "",
            "consentimientoFirmado": "NO", "fechaConsentimiento": "", "tipoPago": "sesion",
            "linkConsentimiento": ""
        })
        paciente_vinculado_id = res.get("id") if res else None
        registrar_creado("Pacientes", paciente_vinculado_id)
        r.check("Borrar Pacientes con vínculos — crear paciente para el caso", res is not None and res.get("ok") is True, err or f"id: {paciente_vinculado_id}")

        if paciente_vinculado_id is None:
            r.skip("Borrar paciente CON turnos/cobros vinculados no rompe nada", "no se pudo crear el paciente de prueba")
        else:
            res_t, err_t = crear(r, "Turnos", {"pacienteId": paciente_vinculado_id, "fecha": "2099-01-07", "hora": "09:00", "estado": "agendado"})
            turno_vinculado_id = res_t.get("id") if res_t else None
            registrar_creado("Turnos", turno_vinculado_id)
            res_c, err_c = crear(r, "Cobros", {"pacienteId": paciente_vinculado_id, "fecha": "2099-01-07", "monto": 12000, "estado": "pendiente"})
            cobro_vinculado_id = res_c.get("id") if res_c else None
            registrar_creado("Cobros", cobro_vinculado_id)
            r.check(
                "Borrar paciente con vínculos — turno y cobro de prueba creados",
                turno_vinculado_id is not None and cobro_vinculado_id is not None,
                f"turno: {err_t}, cobro: {err_c}"
            )

            # Borrar el paciente (esto es lo que hace onEliminarPaciente en el
            # frontend, después de que el usuario confirma el aviso).
            borrar(r, "Pacientes", paciente_vinculado_id)
            data, err2 = leer_con_reintento(r, lambda d: buscar(d.get("pacientes", []), paciente_vinculado_id) is None)
            paciente_borrado_ok = data is not None and buscar(data.get("pacientes", []), paciente_vinculado_id) is None
            r.check("Borrar paciente CON turnos/cobros vinculados — el paciente se borra igual", paciente_borrado_ok, err2 or "")
            if paciente_borrado_ok:
                marcar_borrado("Pacientes", paciente_vinculado_id)

            # El turno y el cobro deben seguir existiendo (huérfanos), sin
            # que la lectura general se rompa — es exactamente lo que ya
            # garantizan H3/H4 (pacienteId sin match no bloquea nada).
            turno_huerfano = buscar(data.get("turnos", []), turno_vinculado_id) if data else None
            cobro_huerfano = buscar(data.get("cobros", []), cobro_vinculado_id) if data else None
            r.check(
                "Borrar paciente con vínculos — el turno queda huérfano sin romper la lectura",
                turno_huerfano is not None and _leer_paciente_id(turno_huerfano) == paciente_vinculado_id,
                f"turno: {turno_huerfano}"
            )
            r.check(
                "Borrar paciente con vínculos — el cobro queda huérfano sin romper la lectura",
                cobro_huerfano is not None and _leer_paciente_id(cobro_huerfano) == paciente_vinculado_id,
                f"cobro: {cobro_huerfano}"
            )

    finally:
        # ------------------------------------------------------------
        # Limpieza: borrar todo lo que este script haya creado y siga
        # pendiente, en orden Cobros/Turnos antes que Pacientes. Nunca
        # revienta el script, pase lo que pase arriba.
        # ------------------------------------------------------------
        print("\nLimpiando datos de prueba...", flush=True)
        for cid in list(creados["Cobros"]):
            try:
                borrar(r, "Cobros", cid, op_label="cleanup_delete")
            except Exception as e:  # noqa: BLE001
                print(f"  (no se pudo limpiar Cobros id={cid}: {e})")
        for tid in list(creados["Turnos"]):
            try:
                borrar(r, "Turnos", tid, op_label="cleanup_delete")
            except Exception as e:  # noqa: BLE001
                print(f"  (no se pudo limpiar Turnos id={tid}: {e})")
        for pid in list(creados["Pacientes"]):
            try:
                borrar(r, "Pacientes", pid, op_label="cleanup_delete")
            except Exception as e:  # noqa: BLE001
                print(f"  (no se pudo limpiar Pacientes id={pid}: {e})")

        data_final, err = leer(r, "read_final")
        if data_final is not None:
            quedan_restos = any(TAG in json.dumps(p) for p in data_final.get("pacientes", []))
            r.check("Limpieza — no queda ningún dato de prueba con el tag en Pacientes", not quedan_restos, "revisar manualmente si esto falla")
        else:
            r.check("Lectura final para confirmar limpieza", False, err)

    ok_total = r.resumen()
    sys.exit(0 if ok_total else 1)


if __name__ == "__main__":
    main()
