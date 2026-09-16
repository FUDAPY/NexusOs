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

> El puerto 5220 **ya no se publica** (ver `docker-compose.yml`): Mongo no queda expuesto a
> internet, porque con el puerto abierto la contraseña del root es la **única** barrera. Para correr
> estos scripts desde tu máquina, descomentá el `ports` del servicio `mongo` **temporalmente** y
> volvé a comentarlo al terminar; o corré los comandos `mongosh` desde la terminal del contenedor,
> que no necesita el puerto.

### ⚠️ 502 en TODO (incluido `/health`) después de un redeploy

**Síntoma:** el frontend carga bien (nginx sirve los estáticos, se ve la pantalla de login), pero
**cualquier** ruta del API devuelve `502 Bad Gateway`, incluido `/health`. Desde la consola del
navegador se ve `Failed to load resource: 502` y `Error al iniciar sesión: HTTP 502`.

**Qué NO es:** no es el login, ni el rate limiter, ni la base caída. Un 502 en `/health` significa
que nginx no puede hablar con la API: no hay nada escuchando en el puerto 3000.

**Por qué la API no abre el puerto:** `src/index.ts` hace `server.listen()` **después** de
`connectDatabase()`. Si Mongo no responde, `mongoose.connect` lanza, `bootstrap` hace
`process.exit(1)` y el contenedor entra en bucle de reinicio **sin haber abierto nunca el puerto**.

**La causa más probable — el host del replica set quedó viejo:**

El config del replica set se guarda en los volúmenes `mongo-data`/`mongo-config`, así que
**sobrevive a los redeploys**. Pero el hostname que Dokploy le da al contenedor
(`pos-erppos-3yohnd`) es **aleatorio y cambia en cada deploy**. Si en algún momento se inicializó
el conjunto con ese nombre:

1. queda guardado `members[0].host = "pos-erppos-3yohnd:27017"` en el volumen;
2. el siguiente redeploy recrea el contenedor con otro nombre;
3. mongod busca un miembro que ya no existe → el conjunto **nunca elige primary**;
4. el API exige primary escribible → timeout de 10s → `process.exit(1)` → bucle → **502**.

El host guardado **tiene que ser `mongo:27017`** (el nombre del servicio en `docker-compose.yml`),
que es estable mientras no cambie el proyecto de Dokploy.

### ⚠️ 502 en TODO y en los logs `Authentication failed` (code 18)

**Síntoma:** igual que el caso anterior (502 en todo, incluido `/health`), pero en los logs del `api`:

```json
"err":{"type":"MongoServerError","message":"Authentication failed."},
"errorResponse":{"code":18,"codeName":"AuthenticationFailed"},
"msg":"Fallo el arranque del servicio"
```

**Qué significa:** Mongo **respondió** y **rechazó la credencial**. No es red, ni topología, ni el
replica set: es que la contraseña que usa el `api` no es la que tiene el usuario dentro del volumen.

**La causa — y es la trampa más cara de este proyecto:**

| Variable | Quién la usa | Cuándo |
| --- | --- | --- |
| `MONGO_INITDB_ROOT_PASSWORD` | el contenedor `mongo` | **solo la primera vez**, con el volumen **vacío** |
| `MONGO_PASSWORD` (→ `MONGO_URI`) | el contenedor `api` | **en cada arranque** |

Las dos salen de la **misma** variable del Environment, así que **es imposible que los contenedores
tengan contraseñas distintas**. La discrepancia es entre **la variable** y **lo que quedó guardado en
el volumen `mongo-data`**.

Si alguien cambia `MONGO_INITDB_ROOT_PASSWORD` en Dokploy y redespliega:

- `api` y `mongo` pasan a usar la nueva → el `api` intenta con la nueva;
- el usuario `giuli` **sigue con la vieja**, porque `MONGO_INITDB_ROOT_*` ya no se aplica;
- → `AuthenticationFailed` en bucle → el puerto 3000 nunca se abre → **502**.

**Cómo confirmarlo.** Dentro del contenedor `mongo` (Dokploy → Docker Compose → Terminal):

```bash
# ¿Cuál es la que Mongo tiene de verdad? Probá la que está en el Environment.
mongosh --quiet -u giuli -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval 'db.runCommand({connectionStatus:1}).ok'
```

Si eso falla pero el `api` existía antes, buscá la clave anterior en el historial del repo:

```bash
git log --all -p -- '*.example' | grep -iE 'MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD' | sort -u
```

**Cómo arreglarlo.** Con la clave vieja, alineá Mongo con lo que ya está en Dokploy:

```bash
mongosh --quiet -u giuli -p '<CLAVE_VIEJA>' --authenticationDatabase admin \
  --eval 'db.getSiblingDB("admin").changeUserPassword("giuli", "<CLAVE_NUEVA>")'
```

Después actualizá `MONGO_INITDB_ROOT_PASSWORD` en el Environment con el **mismo** valor y redesplegá.
Los dos lados tienen que quedar alineados: si cambiás Mongo y dejás la variable vieja, el `api` falla
exactamente igual y parece que no hiciste nada.

**Regla para no repetirlo:** cambiar `MONGO_INITDB_ROOT_PASSWORD` en Dokploy **no cambia ninguna
contraseña existente**. Hay que hacer las dos cosas: `changeUserPassword` en Mongo **y** la variable
en el Environment.

> **Nunca pongas la contraseña real en un `*.example`.** Este proyecto ya perdió acceso una vez por
> eso: la clave quedó en el historial de un repo **público** y fue la única forma de recuperarla.
> Los `.example` van con placeholders; si una credencial llegó a un commit, la única mitigación real
> es rotarla.

### Por qué el host del conjunto TIENE que ser `mongo:27017`

En Compose el **nombre del servicio es el alias DNS** dentro de la red `<proyecto>_default`, y no
depende del nombre del proyecto que le asigne Dokploy. Por eso:

- el `api` se conecta con `MONGO_URI = mongodb://...@mongo:27017/...` (viene de `MONGO_HOST` en
  `docker-compose.yml`);
- nginx proxya a `api:3000` (`API_UPSTREAM`) por el mismo mecanismo.

El driver de Mongo **primero** conecta al host de la URI y **después** lee el config del conjunto y
se conecta a los hosts *anunciados* por cada miembro. Si el anunciado es un nombre que ya no existe,
el descubrimiento de topología nunca termina: `serverSelectionTimeoutMS` (10s) expira, `mongoose.connect`
lanza, `bootstrap` hace `process.exit(1)` **antes de `server.listen()`**, y nginx devuelve 502 en todas
las rutas. Por eso el host anunciado y `MONGO_HOST` tienen que ser **el mismo valor estable**.

**Cómo confirmarlo.** Desde la Terminal del stack (Dokploy → Docker Compose → Terminal), o con la
consola del host:

```bash
# <proyecto> es el que usa Dokploy en `docker compose -p <proyecto>`
docker compose -p <proyecto> exec mongo mongosh --quiet \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval 'rs.status().members.map(m => m.name + " = " + m.stateStr)'
```

Si aparece un nombre tipo `pos-erppos-3yohnd:27017`, o el estado nunca llega a `PRIMARY`, es esto.

**Cómo arreglarlo** (mismo contenedor):

```bash
docker compose -p <proyecto> exec mongo mongosh --quiet \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval 'const c = rs.conf(); c.members[0].host = "mongo:27017"; rs.reconfigure(c, true); rs.status().members[0].stateStr'
```

`force: true` es obligatorio: un conjunto de un solo nodo cuyo único miembro es inalcanzable **no
puede** elegir primary, y `replSetReconfig` normal exige ser primary.

Por último, **redeploy del stack** para que el `api` vuelva a arrancar, y verificar:

```bash
curl -s https://<tu-dominio>/health
```

**Para que no vuelva a pasar:** `npm run mongo:replica:init` ahora detecta el host viejo y lo
reescribe solo (`repararHostSiHaceFalta`). El default es `mongo:27017`; si necesitás otro nombre,
pasá `REPLICA_HOST=<host:puerto>` — pero **nunca** el nombre que genera Dokploy.

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
