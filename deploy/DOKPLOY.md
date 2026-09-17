# Desplegar TODO con el compose de Dokploy

Esta es la guía del despliegue declarativo: **un solo servicio "Docker Compose"** en Dokploy levanta
la stack entera. No hay servicios "Application" aparte, ni pasos por terminal, ni comandos a mano
después del deploy.

> Lo que **sí** se sigue haciendo a mano está listado al final, en
> [Lo que todavía no es automático](#lo-que-todavía-no-es-automático). Hoy es un solo punto.
>
> Los procedimientos operativos (rotar contraseñas, usar la terminal del panel, recuperar
> contraseñas de usuarios) siguen en [`deploy/README.md`](./README.md).

## Qué levanta

| Servicio | Imagen | Qué hace | Se conecta a |
| --- | --- | --- | --- |
| `mongo-keyfile` | `mongo:8` | Genera la clave de autenticación interna del replica set (obligatoria con `--auth` + `--replSet`) y termina | — |
| `mongo` | `mongo:8` | Base de datos, replica set de 1 nodo (habilita **transacciones**) | red del proyecto |
| `redis` | `redis:7` | Caché y locks de stock | red del proyecto |
| `mongo-init` | `pos-cate-api:local` | Inicializa el replica set y **repara el host** si Dokploy recicló el nombre del contenedor. Termina | red del proyecto |
| `api` | `pos-cate-api:local` | Node/Express. No publica puertos | red del proyecto |
| `web` | `pos-cate-web:local` | nginx: sirve `frontend/` y hace de reverse proxy al API. **Único con dominio** | proyecto + `dokploy-network` |

Un solo origen sirve la app y el API, así que **no hay CORS** y el APK apunta siempre al mismo host.

## Requisitos antes de desplegar

1. **DNS**: un registro `A` de tu dominio apuntando a la IP del VPS.
   Lets Encrypt valida el dominio **por HTTP**: si el DNS todavía no propagó, el certificado no se
   emite y el sitio queda con el aviso de certificado inválido. Probá con
   `nslookup tu-dominio.com` antes de desplegar.
2. **`dokploy-network`**: la crea Dokploy al instalarse, así que en el VPS ya está. Solo si vas a
   levantar el stack en una máquina de desarrollo hay que crearla una vez:
   ```bash
   docker network create dokploy-network
   ```
3. **Puerto 80 y 443 libres** en el VPS: de eso se encarga Traefik, que ya viene con Dokploy.

## Variables

Están todas (y explicadas) en [`.env.example`](../.env.example). Las que hay que **cambiar sí o sí**:

| Variable | Nota |
| --- | --- |
| `MONGO_INITDB_ROOT_PASSWORD` | Si es la que ya se usó, **no sirve**: quedó en el historial de Git de este repo público. Ver "Rotar la contraseña de Mongo" en `README.md` |
| `REDIS_PASSWORD` | Si se cambia después de que existe el volumen `redis-data`, Redis sigue con la vieja: hay que borrar el volumen |
| `JWT_SECRET` | Mínimo **32 caracteres**, o el API no arranca (lo valida `config/env.ts`) |
| `DOMINIO` | El host público, sin `https://` ni barra final. Ej: `pos.tudominio.com` |

> Dokploy guarda estas variables en un `.env` al lado del compose y lo pasa con `--env-file`.
> **No las inyecta en los contenedores por su cuenta**: por eso el compose las referencia una por
> una con `${...}`. Si agregás una variable nueva y el contenedor no la ve, es por esto.

## Paso a paso

1. **Dokploy → tu proyecto → Create Service → Docker Compose.**
2. **General** → conectá el repositorio y la rama. Dejá la ruta del compose en `./docker-compose.yml`
   (es la raíz del repo, la que Dokploy usa por defecto).
3. **Environment** → pegá el contenido de `.env.example` con los valores reales.
4. **Deploy.** La primera vez tarda más: construye dos imágenes (API y web) y Mongo inicializa el
   volumen. Después de ese primer deploy, andá a **Domains** y seguí la sección siguiente **solo si
   elegís el camino de la UI**.

## El dominio: elegí UN camino, no los dos

El dominio se puede declarar de dos maneras y **no son combinables**: si usás las dos, quedan dos
routers de Traefik para el mismo host y el comportamiento pasa a depender del orden en que Traefik
los lea.

| Camino | Cómo | Cuándo conviene |
| --- | --- | --- |
| **A · En el compose** (el que está puesto) | Cargás `DOMINIO` y listo: el compose ya trae los labels de Traefik, el redirect a HTTPS y el certificado | Querés que **todo** viva en el compose: mismo archivo en desarrollo y en producción, y el dominio versionado |
| **B · En la UI** | Pestaña **Domains** → Add Domain. Dokploy inyecta los labels solo | Preferís no tocar el compose, o querés cambiar el dominio sin redeploy |

Si elegís **B**, **comentá el bloque `labels:` del servicio `web`** en el compose. Si no, los dos
caminos conviven y queda impredecible cuál gana.

El camino **A** ya está configurado así:

- `web` escucha en **80** dentro del contenedor (el puerto que hay que poner en la UI si usás B).
- HTTP (`web`) **redirige** a HTTPS (`websecure`).
- El certificado lo emite Lets Encrypt con el resolver `letsencrypt` (el que Dokploy configura).
- El healthcheck de la UI de Dokploy, en Monitor, debería ver `web` como **healthy**.

## Qué pasa solo, en cada deploy

Esto es lo que antes había que hacer a mano y ahora está en el compose. Vale la pena saberlo porque
explica por qué un deploy tarda lo que tarda y por qué el orden importa:

1. **Se genera la clave del replica set** si no existe (`mongo-keyfile`). No se pisa si ya está:
   regenerarla rompería el handshake entre nodos.
2. **Mongo arranca y se espera a que CONTESTE**, no a que el contenedor exista. El healthcheck hace
   `ping` con credenciales (mongod corre con `--auth`).
3. **Se inicializa el replica set** (`mongo-init`). Sin esto el nodo no tiene PRIMARY, el driver
   exige primary escribible y el API muere **antes de abrir el puerto** → 502 en todas las rutas,
   incluido `/health`. Además **las transacciones no corren sin primary**, y de transacciones
   dependen la venta, el cobro de mesa y el cierre de caja.
4. **Se repara el host del conjunto si Dokploy lo recicló.** Este es el "502 fantasma" del
   `README.md`: la config del conjunto vive en el volumen y sobrevive a los redeploys, pero el
   hostname del contenedor cambia en cada deploy. El script detecta que el host guardado no es el
   estable (`mongo:27017`) y lo reescribe. Como corre en cada deploy, **ya no puede quedar roto**.
5. **Recién ahí arranca el API**, y solo si el paso 3 terminó bien (`service_completed_successfully`).
   Si falla, el API **no arranca**: es a propósito, porque un API sin transacciones es un 502 en
   todo el sitio que además esconde el motivo.
6. **nginx arranca** (depende de `api` con `service_started`, no `healthy`: si el frontend esperara a
   que el API esté sano, el sitio entero sería un 502 en vez de un login que carga y avisa).

## Lo que todavía no es automático

**Un solo punto: los índices de MongoDB.**

En producción `autoIndex` es `false`, así que los índices declarados en los esquemas **no se crean
solos**. Hay que correrlos una vez por cambio de esquema:

```bash
# Dentro del contenedor del api (Dokploy → api → Terminal):
npm run mongo:indices
```

No se puso en el compose **a propósito**: crear un índice único falla si ya hay datos duplicados, y
si eso pasara dentro del arranque, tumbaría el deploy entero. Como está, el deploy entra igual y el
índice se crea cuando vos decidas.

> Antes de correrlo la primera vez hay que limpiar los `turnoId` duplicados. Ver Fase 5.2 y 5.3 en
> [`docs/ROADMAP-ADMIN.md`](../docs/ROADMAP-ADMIN.md).

## Respaldos

Los datos viven en **volúmenes con nombre** (`mongo-data`, `mongo-config`, `redis-data`), que son los
únicos que Dokploy puede respaldar:

**Dokploy → tu servicio → Volume Backups** → configurá un destino S3 y un horario.

No se usan rutas del repo para los datos, y no es solo prolijidad: **Dokploy borra el directorio
clonado en cada deploy**, así que unos datos ahí se perderían.

## Probar el stack en tu máquina antes de desplegar

El mismo compose se levanta local y se verifica solo:

```bash
# Desde la raíz del repo
sh deploy/prueba-local.sh
```

Hace todo el ciclo: crea `dokploy-network` si falta, construye las dos imágenes, levanta el stack,
espera a que el API conteste **a través de nginx**, prueba las rutas principales (login, POS, API sin
token, ruta inexistente) y al final borra **solo** el proyecto de prueba (`pos-prueba`) con sus
volúmenes. Si algo falla, imprime los logs de `mongo-init` y del `api`, que es donde está la causa.

> Necesita el daemon de Docker corriendo. No usa Traefik ni el dominio real: prueba nginx → api →
> mongo, que es la parte que puede fallar por el replica set. El dominio y el certificado solo se
> prueban en el VPS, porque dependen de DNS público.

## Verificar que quedó bien

```bash
# 1. El API responde (por el dominio, o sea que Traefik y nginx estan bien)
curl -s https://tu-dominio.com/health

# 2. El certificado se emitio
curl -sI https://tu-dominio.com | head -1

# 3. En Dokploy → tu servicio → Monitor: web y api en healthy
```

Y después, en la aplicación:

1. **Entrar** al POS con un usuario real.
2. **Abrir turno** con un fondo.
3. **Una venta directa** con un producto controlado y un cliente: el stock baja, los puntos suman,
   el ticket sale.
4. **Una mesa** (abrir y cobrar): la venta aparece una sola vez.
5. **Cerrar caja**: el ticket Z coincide con lo que muestra el relatorio.

## Si algo sale mal

| Síntoma | Causa casi segura | Qué hacer |
| --- | --- | --- |
| **502 en TODAS las rutas**, incluido `/health` | El conjunto quedó sin primary, o el API no arrancó | Dokploy → `mongo-init` → Logs. Si dice "no quedo inicializado", mirá los logs de `mongo`; si el API no arrancó, mirá los del `api` (casi siempre es una variable faltante: `JWT_SECRET` corto, `REDIS_URL`) |
| **403 en `/`** y 404 en `/favicon.ico` | nginx no puede leer los archivos | No debería pasar: el `Dockerfile` hace `chmod -R a+rX` y embebe el frontend. Si pasa, el problema está en la imagen, no en un bind mount |
| **El certificado no se emite** | El DNS todavía no apunta al VPS, o el puerto 80 está ocupado | `nslookup tu-dominio.com` y revisá los logs de Traefik en Dokploy |
| **"desplegué y sigue igual"** | Caché del navegador | Los `.html` y `.js` van con `no-cache` justamente para esto. Si igual pasa, mirá si el deploy realmente reconstruyó la imagen `web` |
| **El dominio muestra el sitio pero `/api/` da 502** | nginx no resuelve `api` | Revisá que el servicio se llame `api` en el compose, o ajustá `API_UPSTREAM` |
