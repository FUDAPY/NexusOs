# ===================================================================
# NexusOS · imagen del servicio "web"
# ===================================================================
# nginx + el frontend EMBEBIDO en la imagen.
#
# Por que no se monta ./frontend por bind:
#   Con un bind mount, si la ruta relativa no resuelve o los permisos del
#   directorio clonado no son legibles para el usuario nginx (uid 101), el
#   contenedor arranca SIN errores pero nginx no puede leer nada:
#       /            -> 403  (directory index ... is forbidden)
#       /favicon.ico -> 404
#   Embeber el contenido elimina la dependencia del host por completo.
#
# El contexto de build es la RAIZ del repo (ver docker-compose.yml).
# El .dockerignore de la raiz deja fuera todo lo que no hace falta.
# ===================================================================
FROM nginx:1.27-alpine

# Quita la pagina de bienvenida para que no quede nada huerfano.
RUN rm -f /usr/share/nginx/html/index.html /usr/share/nginx/html/50x.html

# Frontend embebido.
COPY frontend/ /usr/share/nginx/html/

# Plantilla de configuracion. La imagen la procesa al arrancar:
#   /etc/nginx/templates/*.template --envsubst--> /etc/nginx/conf.d/default.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template

# chmod explicito: COPY conserva los permisos del origen, y el usuario nginx
# (uid 101) tiene que poder leer y atravesar todo. a+rX = lectura para todos y
# bit de ejecucion SOLO en directorios.
RUN chmod -R a+rX /usr/share/nginx/html && \
    chmod a+r /etc/nginx/templates/default.conf.template

# bash: alpine trae solo sh y la terminal web de Dokploy invoca bash.
# curl: permite diagnosticar desde dentro del contenedor (curl -I localhost).
RUN apk add --no-cache bash curl

EXPOSE 80

# Verifica que el sitio se sirva de verdad, no solo que nginx este vivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1/ || exit 1
