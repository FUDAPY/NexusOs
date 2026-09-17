#!/bin/sh
# ===================================================================
# Inicializa el replica set de MongoDB. Lo ejecuta el servicio "mongo-init" del
# docker-compose.yml en CADA deploy, antes de que arranque el api.
#
# POR QUE ESTE ENVOLTORIO Y NO LLAMAR DIRECTO AL SCRIPT DE TYPESCRIPT:
#   scripts/init-replica-set.ts ya es idempotente y ya repara el host reciclado,
#   pero NO reintenta. En el primer arranque (volumen vacio) mongod esta creando
#   el usuario root y todavia no acepta conexiones: el primer intento falla por
#   una condicion transitoria y, como el api espera a que este paso TERMINE BIEN,
#   el deploy entero se caeria sin motivo.
#
# Sale 0 cuando el conjunto ya tiene PRIMARY (lo haya promovido ahora o antes), y
# 1 si se agotaron los intentos. El compose usa ese codigo: si esto falla, el api
# NO arranca. Es a proposito, no un efecto secundario: sin primary no hay
# transacciones y todas las rutas responden 502, incluido /health.
#
# Se puede ajustar sin editar el archivo:
#   INTENTOS (40)   veces que reintenta
#   ESPERA   (5)    segundos entre intentos
# ===================================================================

set -u

INTENTOS="${INTENTOS:-40}"
ESPERA="${ESPERA:-5}"

i=1
while [ "$i" -le "$INTENTOS" ]; do
  echo "[mongo-init] intento $i/$INTENTOS"
  if npm run --silent mongo:replica:init; then
    echo "[mongo-init] replica set listo: el api puede arrancar"
    exit 0
  fi
  echo "[mongo-init] todavia no esta; reintento en ${ESPERA}s"
  i=$((i + 1))
  sleep "$ESPERA"
done

echo "[mongo-init] FALLO: el replica set no quedo inicializado tras $INTENTOS intentos" >&2
exit 1
