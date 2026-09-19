#!/bin/sh
# ===================================================================
# Prueba local del stack COMPLETO, con el MISMO docker-compose.yml que usa
# Dokploy. Verifica que el compose ARRANCA, que no es lo mismo que sea valido:
# levanta mongo, redis, api y web, espera a que el API conteste A TRAVES de
# nginx y despues se limpia solo.
#
# POR QUE CONSULTA A TRAVES DE NGINX Y NO AL API DIRECTO:
#   lo que hay que probar es la cadena entera (nginx -> api -> mongo). Y un
#   /health que contesta es, de paso, la prueba de que el replica set TIENE
#   PRIMARY: si el conjunto quedara sin inicializar, el API no llega a abrir el
#   puerto y no habria nada escuchando del otro lado.
#
# Uso, desde la RAIZ del repo:
#   sh deploy/prueba-local.sh
#
# Usa las variables que ya esten en el entorno y completa las que falten con
# valores de prueba. El proyecto se llama aparte (pos-prueba) y al final borra
# SOLO sus propios volumenes: no toca nada de otros stacks.
# ===================================================================
set -eu

if [ ! -f docker-compose.yml ]; then
  echo "FALLA: corré el script desde la raíz del repo (no encuentro docker-compose.yml)." >&2
  exit 1
fi

PROYECTO="${PROYECTO:-pos-prueba}"

# --- 1. El daemon tiene que estar ---
if ! docker info >/dev/null 2>&1; then
  echo "FALLA: el daemon de Docker no responde. Arrancá Docker Desktop y reintentá." >&2
  docker info 2>&1 | tail -3 >&2
  exit 1
fi

# --- 2. La red de Dokploy (en el compose es externa) ---
if ! docker network inspect dokploy-network >/dev/null 2>&1; then
  echo "--- Creando dokploy-network (no existía)"
  docker network create dokploy-network >/dev/null
fi

# --- 3. Variables: solo las que falten ---
export MONGO_INITDB_ROOT_USERNAME="${MONGO_INITDB_ROOT_USERNAME:-giuli}"
export MONGO_INITDB_ROOT_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD:-ClaveDePruebaLocal123456789}"
export MONGO_INITDB_DATABASE="${MONGO_INITDB_DATABASE:-pos_cate_prueba}"
export REDIS_PASSWORD="${REDIS_PASSWORD:-ClaveRedisLocal123456789}"
# 32 caracteres o mas: config/env.ts rechaza menos y el API no arranca.
export JWT_SECRET="${JWT_SECRET:-clave-de-prueba-local-para-jwt-32chars}"
export DOMINIO="${DOMINIO:-pos.prueba.local}"

limpiar() {
  echo ""
  echo "--- Limpiando el proyecto de prueba '$PROYECTO' (y SOLO ese)"
  docker compose -p "$PROYECTO" down -v >/dev/null 2>&1 || true
}
trap limpiar EXIT INT TERM

echo "--- Build de las imagenes (api y web)"
docker compose -p "$PROYECTO" build

echo "--- Up: mongo, keyfile, mongo-init, redis, api, web"
docker compose -p "$PROYECTO" up -d

echo "--- Esperando al API a traves de nginx (hasta 180s)"
listo=0
i=1
while [ "$i" -le 60 ]; do
  if docker compose -p "$PROYECTO" exec -T web curl -fsS http://127.0.0.1/health 2>/dev/null | grep -q '"status":"ok"'; then
    listo=1
    break
  fi
  printf '.'
  i=$((i + 1))
  sleep 3
done
echo ""

if [ "$listo" -ne 1 ]; then
  echo "FALLA: el API no respondió en 180s. Estado y logs:" >&2
  docker compose -p "$PROYECTO" ps >&2
  echo "--- mongo-init (es el que inicializa el replica set)" >&2
  docker compose -p "$PROYECTO" logs mongo-init --tail 30 >&2
  echo "--- api" >&2
  docker compose -p "$PROYECTO" logs api --tail 30 >&2
  exit 1
fi

echo "OK   /health responde a través de nginx  (nginx -> api -> mongo, con primary)"

# --- 4. La cadena completa ---
probar() {
  descripcion="$1"
  esperado="$2"
  url="$3"
  codigo=$(docker compose -p "$PROYECTO" exec -T web curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)
  if [ "$codigo" = "$esperado" ]; then
    echo "OK   $descripcion  ($codigo)"
  else
    echo "FALLA $descripcion: esperaba $esperado y dio $codigo" >&2
    return 1
  fi
}

probar "La pantalla de acceso se sirve"           200 "/"
probar "El POS se sirve"                          200 "/pos.html"
probar "El API sin token responde 401"            401 "/api/v1/orders"
probar "Una ruta inexistente cae en el login"     200 "/esta-ruta-no-existe"

echo ""
echo "TODO OK: el stack arranca y sirve de punta a punta."
