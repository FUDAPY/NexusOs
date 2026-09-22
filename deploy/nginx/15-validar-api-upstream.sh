#!/bin/sh
# ===================================================================
# NexusOS - valida API_UPSTREAM antes de generar la config de nginx
# ===================================================================
# La imagen oficial de nginx ejecuta (con "source") los archivos de
# /docker-entrypoint.d/ en orden, ANTES de 20-envsubst-on-templates.sh, que es
# el que sustituye ${API_UPSTREAM} en la plantilla. Este script corre primero y
# puede corregir/exportar la variable.
#
# POR QUE EXISTE
#   Si API_UPSTREAM es una IP (ej. 10.0.1.65:3000) nginx NO puede re-resolverla:
#   una IP no cambia de direccion. Cuando el contenedor del API se recrea y toma
#   otra IP, el web queda apuntando a la vieja y devuelve 502 (incluso en
#   /api/v1/auth/login) hasta que alguien reinicia nginx a mano.
#   Con el NOMBRE del servicio (api:3000) + "resolver 127.0.0.11 valid=10s" la
#   plantilla re-resuelve cada 10 s y ese 502 no vuelve a pasar.
#
# QUE HACE
#   1. Si API_UPSTREAM esta vacio  -> usa el nombre por defecto (api:3000).
#   2. Si es una IP y el nombre resuelve -> usa el nombre (y avisa en el log).
#   3. Si es una IP y el nombre NO resuelve -> la deja, pero avisa fuerte: hay
#      que usar el nombre del servicio y compartir red con el API.
#   4. Verifica que el valor final resuelva por DNS interno de Docker.
# ===================================================================

NOMBRE_POR_DEFECTO="api:3000"
valor="${API_UPSTREAM:-}"

resuelve() {
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$1" >/dev/null 2>&1
  else
    nslookup "$1" >/dev/null 2>&1
  fi
}

if [ -z "$valor" ]; then
  valor="$NOMBRE_POR_DEFECTO"
fi

case "$valor" in
  [0-9]*.[0-9]*)
    if resuelve "api"; then
      echo "[web] API_UPSTREAM venia como IP ($valor): se usa el nombre de servicio '$NOMBRE_POR_DEFECTO' para que nginx pueda re-resolverlo cada 10 s." >&2
      valor="$NOMBRE_POR_DEFECTO"
    else
      echo "[web] ATENCION: API_UPSTREAM=$valor es una IP fija y el nombre 'api' no resuelve en esta red." >&2
      echo "[web] => Si el contenedor del API se recrea, el web va a devolver 502." >&2
      echo "[web] => Usa el NOMBRE del servicio del API (ej. api:3000) y comparti red entre api y web." >&2
    fi
    ;;
esac

host="${valor%%:*}"
if resuelve "$host"; then
  ip_resuelta=$( (getent hosts "$host" 2>/dev/null || nslookup "$host" 2>/dev/null) | awk '/^[0-9]/{print $1; exit}')
  echo "[web] API_UPSTREAM=$valor (resuelve a ${ip_resuelta:-?})"

  # Prueba de alcance real: si el nombre resuelve pero NO contesta /health, el
  # nombre esta apuntando a un contenedor viejo/detenido (o el API todavia no
  # arranco). Sin esto, el log no avisaba nada y todo se veia como un 502 opaco.
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 4 -o /dev/null "http://$valor/health"; then
      echo "[web] API alcanzable: http://$valor/health responde OK"
    else
      echo "[web] ATENCION: $valor resuelve a ${ip_resuelta:-?} pero /health NO responde." >&2
      echo "[web] => Si el API ya esta arriba, ese nombre apunta a un contenedor viejo/detenido." >&2
      echo "[web] => Revisar: docker ps -a | grep -i api   (eliminar el contenedor fantasma)" >&2
      echo "[web] => o poner API_UPSTREAM con el NOMBRE del contenedor del API que si responde." >&2
    fi
  fi
else
  echo "[web] API_UPSTREAM=$valor: todavia no resuelve; nginx reintentara cada 10 s con el resolver de Docker."
fi

export API_UPSTREAM="$valor"
