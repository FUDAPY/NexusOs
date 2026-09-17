# ===================================================================
# NexusOS · API  (Node 22 + TypeScript)
# ===================================================================
# Build multi-etapa:
#   build   -> instala TODAS las dependencias, compila TypeScript y poda
#   runtime -> solo dependencias de produccion + dist/ , usuario sin privilegios
#
# El contexto de build es ./server (no la raiz del repo).
#
# Notas:
#  * Se usa alpine porque bcryptjs es JS puro (no hay modulos nativos que
#    compilar). Si alguna dependencia llegara a necesitar glibc, cambiar
#    node:22-alpine por node:22-slim.
#  * tests/ queda fuera del runtime, pero scripts/ SI se copia: ver la etapa
#    runtime. Son la via de recuperacion del sistema.
# ===================================================================

# ---------------- Etapa 1: compilacion ----------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifiestos primero: si el codigo cambia pero las deps no, esta capa se reutiliza.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# scripts/: solo para poder traerlos a la etapa runtime. NO entran al build de
# TypeScript (tsconfig.json los excluye en `exclude`), viaja el fuente tal cual.
COPY scripts ./scripts
RUN npm run build

# Quita devDependencies (typescript, vitest, eslint, tsx...)
RUN npm prune --omit=dev


# ---------------- Etapa 2: runtime ----------------
FROM node:22-alpine AS runtime
WORKDIR /app

# bash no viene en alpine y la terminal web de Dokploy lo invoca por defecto:
#   exec failed: exec: "bash": executable file not found in $PATH (exit 127)
# Son ~1.5 MB y hace que la consola del panel funcione para depurar.
RUN apk add --no-cache bash

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Scripts de operacion: auth:pass, auditar:mongo, mongo:indices, mongo:normalizar.
#
# SI van al runtime, al contrario de lo que decia el encabezado de este archivo.
# Son la via de RECUPERACION: `auth:pass` es lo unico capaz de establecer una
# contrasena cuando NADIE puede entrar (el caso de los 62 usuarios migrados de
# Firebase, que quedaron con passwordHash vacio). Sin esto, un despliegue no
# tiene forma de arrancar la rueda y solo queda mongosh a mano.
#
# Se copia tambien src/: los scripts importan de ../src (config/env, models), y
# en la imagen solo estaba dist/, asi que esos imports no resolvian.
COPY --from=build --chown=node:node /app/src     ./src
COPY --from=build --chown=node:node /app/scripts ./scripts

# tsx para ejecutar los scripts en TypeScript. El `npm prune --omit=dev` de la
# etapa de build lo habia quitado, asi que se instala global. El binario cae en
# /usr/local/bin, que ya esta en el PATH, con lo que `npm run auth:pass` lo
# encuentra sin tocar los scripts del package.json.
RUN npm install --global --no-fund --no-audit tsx@4.19.2 && npm cache clean --force

# El usuario 'node' (uid 1000) ya viene en la imagen oficial.
USER node

EXPOSE 3000

# /health esta montado en la raiz, fuera del prefijo /api/v1.
# Se usa el fetch nativo de Node 22: no hace falta instalar curl ni wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "dist/index.js"]
