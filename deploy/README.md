# Cómo publicar NexusOS en tu dominio (Dokploy)

## Por qué Dokploy solo te ofrece `mongo-keyfile`, `mongo` y `redis`

Los dominios en Dokploy los sirve **Traefik, que es un proxy HTTP**. Para que un servicio pueda
recibir un dominio tiene que **hablar HTTP**. Ninguno de los tres lo hace:

| Servicio | Qué es | Por qué no puede recibir dominio |
| --- | --- | --- |
| `mongo` | Base de datos | Habla el protocolo binario de MongoDB, no HTTP. Traefik no puede enrutarlo. |
| `redis` | Caché | Protocolo Redis (RESP), tampoco HTTP. Además no publica puertos a propósito. |
| `mongo-keyfile` | Tarea puntual | Genera la clave del replica set, imprime `keyfile-listo` y **termina**. No queda proceso escuchando. |

Si asignás el dominio a cualquiera de los tres, Traefik lo enruta a un puerto que no habla HTTP:
vas a ver un **502 Bad Gateway** o un cuelgue. No es un problema de configuración, es que no hay
nada del otro lado.

**Hace falta un servicio HTTP.** Ese es `web`.

## Qué se agregó

```text
docker-compose.yml
  mongo-keyfile   (tarea)
  mongo           (base de datos)
  redis           (caché)
  api             build: ./server            -> Node/Express
  web             build: . (Dockerfile en deploy/nginx/)   <-- ÚNICO con dominio
        ├── sirve el frontend EMBEBIDO en la imagen
        └── proxy /api/, /health, /realtime  ->  api:3000
server/Dockerfile
deploy/nginx/Dockerfile
deploy/nginx/default.conf.template
.dockerignore                        (raíz: recorta el contexto de web)
```

Un solo dominio sirve la app **y** el API, así que **no hay CORS** y el APK apunta siempre al
mismo host.

### Por qué el frontend va DENTRO de la imagen y no por bind mount

La primera versión montaba `./frontend` con un bind mount. En Dokploy eso falla en silencio: si la
ruta relativa no resuelve, o si los permisos del directorio clonado no son legibles para el usuario
`nginx` (uid 101), **Docker crea un directorio vacío en vez de dar error**. El resultado es un
nginx que arranca sin problemas pero no sirve nada:

```text
/            -> 403   directory index of "/usr/share/nginx/html/" is forbidden
/favicon.ico -> 404
```

Embebiendo `frontend/` en la imagen (`COPY frontend/ /usr/share/nginx/html/`) desaparece toda
dependencia del host. Además el Dockerfile hace `chmod -R a+rX` para garantizar legibilidad sin
importar los permisos del origen.

Efecto secundario bueno: como la config y el frontend viajan en la imagen, **cualquier cambio
invalida la capa `COPY` y fuerza el rebuild**. Ya no puede quedar un nginx corriendo con la
configuración vieja.

### Por qué el API va dentro del compose

El **nombre del servicio es el nombre del host** en la red de Docker. Poniendo todo en un mismo
compose, `api` alcanza a `mongo` y `redis` sin configuración de red extra, y nginx alcanza a `api`.
No hay que copiar nombres internos de un panel a otro ni depurar si dos servicios comparten red.

El costo: el API pierde Railpack y se construye con `server/Dockerfile`. A cambio, un solo
`Deploy` levanta la stack entera y el `MONGO_URI` se arma con las **mismas variables** que usa
mongo, así la clave vive en un solo lugar.

## Paso a paso en Dokploy

### 1. Desplegar el compose

Subí el repo. En Dokploy → tu proyecto → servicio **Docker Compose** → **Deploy**.

En la pestaña **Environment** tienen que estar:

```
MONGO_INITDB_ROOT_USERNAME=<usuario>
MONGO_INITDB_ROOT_PASSWORD=<clave_larga_y_aleatoria>
MONGO_INITDB_DATABASE=pos_cate
MONGO_EXTERNAL_PORT=5220
REDIS_PASSWORD=<clave_larga_y_aleatoria>
JWT_SECRET=REEMPLAZAR_ESTO
API_UPSTREAM=api:3000
CORS_ORIGINS=
```

> **`JWT_SECRET` tiene que ser un secreto real, no el texto del ejemplo.** Si pegás
> `REEMPLAZAR_ESTO` el contenedor `api` arranca, se cae y entra en bucle con:
> `Configuracion de entorno invalida -> JWT_SECRET: JWT_SECRET debe tener al menos 32 caracteres`
>
> Generalo así (cualquiera de las tres funciona):
>
> ```powershell
> # PowerShell (Windows, sin instalar nada)
> -join (1..64 | ForEach-Object { [char]((65..90)+(97..122)+(48..57) | Get-Random) })
> ```
>
> ```bash
> # Node
> node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
> # Python
> python -c "import secrets; print(secrets.token_urlsafe(48))"
> ```
>
> Copiá la salida y pegala como valor. Tiene que tener **32 caracteres o más**.

> `API_UPSTREAM` es a dónde nginx manda `/api/`, `/health` y `/realtime`. Con el API dentro de este
> compose queda en `api:3000` y no hace falta tocarlo.

Después del deploy, en la lista de servicios del compose tenés que ver **5**: `mongo-keyfile`,
`mongo`, `redis`, `api` y `web`.

### 2. Apuntar el DNS al servidor

En tu proveedor de dominio, creá el registro:

| Tipo | Nombre | Valor | TTL |
| --- | --- | --- | --- |
| `A` | `pos` (o el subdominio que quieras) | `13.140.32.225` | 300 |

Verificá que propagó **antes** de pedir el certificado: si Let's Encrypt no puede resolver el
dominio, la emisión falla.

```bash
nslookup pos.tudominio.com
```

### 3. Asignar el dominio

En Dokploy → servicio Docker Compose → pestaña **Domains** → **Add Domain**:

| Campo | Valor |
| --- | --- |
| **Service Name** | `web` ← esto es lo que responde tu pregunta |
| **Host** | `pos.tudominio.com` |
| **Path** | `/` |
| **Container Port** | `80` |
| **HTTPS** | activado |
| **Certificate Provider** | `Let's Encrypt` |

Guardá. Dokploy escribe las labels de Traefik y recrea el contenedor.

### 4. Verificar

```bash
curl -I https://pos.tudominio.com          # 200 y text/html
curl https://pos.tudominio.com/health      # {"success":true,...}  (502 si el API no está)
```

En el navegador tenés que ver la pantalla de acceso. Si ves **404 de Traefik**, el `Service Name`
no es `web`. Si ves **502**, el contenedor `web` no arrancó: revisá sus logs.

## El API ya está conectado

El compose construye el API con `server/Dockerfile` y lo une a `mongo` y `redis`. No hay nada que
copiar entre paneles: `API_UPSTREAM=api:3000` ya funciona.

```bash
curl https://pos.tudominio.com/health
# {"success":true,"data":{"status":"ok","uptime":123.4}}
```

Si da **502**, mirá los **Logs** del servicio `api`. Causas típicas:

| Mensaje en los logs | Causa |
| --- | --- |
| `Configuracion de entorno invalida -> JWT_SECRET debe tener al menos 32 caracteres` | Falta `JWT_SECRET` en Environment, o tiene menos de 32 caracteres. |
| `MongooseServerSelectionError` o timeout | El replica set no está inicializado (sección siguiente), o la clave de `MONGO_URI` no coincide con la de mongo. |
| `MongoParseError: Password contains unescaped characters` o `Protocol and host list are required` | La contraseña tiene `@ : / ? # [ ] %` sin codificar y el driver rechaza la URI. Definí `MONGO_PASSWORD` (el API la codifica sola) en vez de `MONGO_URI`. |
| `/` responde **403** y los assets **404** | nginx está sirviendo un directorio vacío. Con el frontend embebido ya no puede pasar; si lo ves, el contenedor `web` corre una imagen vieja. Verificá con `docker exec pos-system-<id>-web-1 ls /usr/share/nginx/html \| head`. |
| `/` responde **502** | Traefik no alcanza nginx. Revisá en **Domains** que el *Service Name* sea `web` y el *Container Port* sea `80`. |
| `ECONNREFUSED redis:6379` | `REDIS_PASSWORD` no coincide con la que arrancó redis. Redis fija la clave al crear el volumen: si la cambiaste, hay que borrar el volumen `redis-data`. |
| `EACCES` o el contenedor se reinicia en bucle | El `JWT_SECRET` tiene caracteres que YAML interpreta. Entrecomillalo. |

## Inicializar el replica set (una sola vez)

Las transacciones ACID dependen de esto. Desde el directorio `server/`, con el `.env` apuntando a
la base desplegada:

```bash
npm run mongo:replica:status   # verifica
npm run mongo:replica:init     # inicializa si falta
```

Tiene que reportar `writablePrimary: true` y `replSetStatus: ok`.

> El puerto 5220 se publica justamente para poder correr esto desde tu máquina. Cuando termines
> podés quitar el `ports` del servicio `mongo`: el API lo alcanza igual por la red interna.

## Usar la terminal de Dokploy

Si la consola de un servicio dice:

```
exec failed: unable to start container process: exec: "bash": executable file not found in $PATH
Container closed with code: 127
```

es porque ese contenedor usa `alpine`, que trae `sh` pero no `bash`, y la terminal web invoca
`bash` por defecto. **Qué terminal usar según el caso:**

| Servicio | Imagen | Terminal sirve? | Para qué |
| --- | --- | --- | --- |
| `mongo` | `mongo:8` (Debian) | ✅ sí, trae `bash` y `mongosh` | **rotar contraseñas**, inspeccionar la base |
| `redis` | `redis:7` (Debian) | ✅ sí | `redis-cli` |
| `api` | `node:22-alpine` | ✅ tras el rebuild (se le agregó `bash`) | depurar el servicio |
| `web` | `nginx:1.27-alpine` | ❌ no tiene `bash` | — |

Si la terminal igual no responde, en Dokploy el campo **Run Command** (pestaña Advanced) sirve
para ejecutar un comando puntual dentro del contenedor, y forzar `/bin/sh` en vez de `bash`.

## Rotar la contraseña de Mongo (con la terminal del panel)

**Servicio `mongo` → Terminal.** Ya entrás autenticado como root del contenedor:

```bash
mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin
```

```javascript
use admin
db.changeUserPassword("giuli", "laClaveNuevaLargaYRandom")
```

Después:

1. Actualizá `MONGO_INITDB_ROOT_PASSWORD` en el **Environment** del compose.
   > El `MONGO_URI` del API se arma con esa misma variable: se actualiza solo.
2. **Redesplegá.**

> `MONGO_INITDB_ROOT_PASSWORD` solo se aplica cuando el volumen está **vacío**. Si ya existe
> `mongo-data`, cambiar la variable NO cambia la clave del usuario: hay que usar
> `changeUserPassword` como arriba.


La contraseña real de Mongo quedó escrita en `server/.env.app.example` y `server/.env.database.example`
durante varias versiones. Hoy está en el **historial de Git** de este repositorio público:

```bash
git log --all -S '<la_clave_vieja>' --oneline   # la lista sin problemarse
```

Reemplazar esos archivos por placeholders (ya hecho) **no la borra del historial**: cualquiera que
clone el repo puede recuperarla. La única mitigación real es **cambiarla en la base**.

1. Generá una clave nueva y larga:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
2. Cambiala en Mongo (por `mongosh` contra el puerto 5220, o desde el contenedor):
   ```javascript
   use admin
   db.changeUserPassword("<usuario>", "<clave_nueva>")
   ```
3. Actualizá `MONGO_INITDB_ROOT_PASSWORD` en el **Environment** de Dokploy.
   > El `MONGO_URI` del API se arma con esa misma variable, así que se actualiza solo.
4. Redesplegá el compose.

De paso, poné una `REDIS_PASSWORD` propia y larga: hoy está como placeholder.
> Ojo: si cambiás `REDIS_PASSWORD` después de que el volumen `redis-data` ya existe, redis sigue
> arrancando con la clave vieja. Borrá el volumen `redis-data` para que tome la nueva.
