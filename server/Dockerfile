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
#  * No se copian tests/ ni scripts/ al runtime: no hacen falta y el
#    .dockerignore ya los excluye del contexto.
# ===================================================================

# ---------------- Etapa 1: compilacion ----------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifiestos primero: si el codigo cambia pero las deps no, esta capa se reutiliza.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Quita devDependencies (typescript, vitest, eslint, tsx...)
RUN npm prune --omit=dev


# ---------------- Etapa 2: runtime ----------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# El usuario 'node' (uid 1000) ya viene en la imagen oficial.
USER node

EXPOSE 3000

# /health esta montado en la raiz, fuera del prefijo /api/v1.
# Se usa el fetch nativo de Node 22: no hace falta instalar curl ni wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "dist/index.js"]
