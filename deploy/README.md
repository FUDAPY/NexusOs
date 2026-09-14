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

```
docker-compose.yml
  mongo-keyfile   (tarea)
  mongo           (base de datos)
  redis           (caché)
  web             (nginx)  <-- ÚNICO con dominio
        ├── sirve ./frontend como estático  (24 páginas)
        └── proxy /api/, /health, /realtime  ->  el API
deploy/nginx/default.conf.template
```

El frontend se monta desde `./frontend` (el repo clonado ya está en el host): **no hace falta
hornearlo en una imagen**. Cambiás un HTML, redesplegás y aparece.

Un solo dominio sirve la app **y** el API, así que **no hay CORS** y el APK apunta siempre al
mismo host.

## Paso a paso en Dokploy

### 1. Desplegar el compose

Subí el repo. En Dokploy → tu proyecto → servicio **Docker Compose** → **Deploy**.

En la pestaña **Environment** tienen que estar:

```
MONGO_INITDB_ROOT_USERNAME=giuli
MONGO_INITDB_ROOT_PASSWORD=<tu_clave>
MONGO_INITDB_DATABASE=pos_cate
MONGO_EXTERNAL_PORT=5220
REDIS_PASSWORD=<tu_clave_redis>
API_UPSTREAM=api:3000
```

> `API_UPSTREAM` es a dónde nginx manda `/api/`, `/health` y `/realtime`. Si el API todavía no
> está desplegado, deja `api:3000`: nginx arranca igual y solo esas rutas dan 502. El resto del
> sitio funciona.

Después del deploy, en la lista de servicios del compose tenés que ver **4**: `mongo-keyfile`,
`mongo`, `redis` y `web`.

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

## Conectar el API

El API todavía no está desplegado. Cuando lo hagas, hay dos caminos:

### Opción A — API como *Application* aparte (mantiene Railpack 0.15.4)

1. Dokploy → **Create Service → Application**. Repositorio el mismo.
2. **Build Path**: `server/` · **Builder**: Railpack 0.15.4
3. **Environment** (tomado de `server/.env.app.example`):

```
NODE_ENV=production
PORT=3000
API_PREFIX=/api/v1
MONGO_URI=mongodb://giuli:<clave>@mongo:27017/pos_cate?authSource=admin&replicaSet=rs0
REDIS_URL=redis://default:<clave>@redis:6379/0
JWT_SECRET=<secreto de 48 bytes>
CORS_ORIGINS=https://pos.tudominio.com
```

4. Copiá el **nombre interno** que Dokploy le asigna y ponelo en el compose:

```
API_UPSTREAM=<nombre-interno-del-application>:3000
```

5. Redesplegá el compose para que nginx tome el nuevo valor.

### Opción B — API dentro del mismo compose

Más simple de conectar (comparte red, sin nombres mágicos), pero pierde Railpack: hay que escribir
un `Dockerfile` para el API. Quedaría así:

```yaml
  api:
    build:
      context: ./server
    environment:
      NODE_ENV: production
      PORT: "3000"
      API_PREFIX: /api/v1
      MONGO_URI: "mongodb://${MONGO_INITDB_ROOT_USERNAME}:${MONGO_INITDB_ROOT_PASSWORD}@mongo:27017/${MONGO_INITDB_DATABASE}?authSource=admin&replicaSet=rs0"
      REDIS_URL: "redis://default:${REDIS_PASSWORD}@redis:6379/0"
      JWT_SECRET: "${JWT_SECRET:?definir JWT_SECRET}"
      CORS_ORIGINS: "https://pos.tudominio.com"
    depends_on:
      - mongo
      - redis
    restart: unless-stopped
```

Con esto `API_UPSTREAM=api:3000` funciona sin tocar nada más.

## Inicializar el replica set (una sola vez)

Las transacciones ACID dependen de esto. Desde el directorio `server/`, con el `.env` apuntando a
la base desplegada:

```bash
npm run mongo:replica:status   # verifica
npm run mongo:replica:init     # inicializa si falta
```

Tiene que reportar `writablePrimary: true` y `replSetStatus: ok`.
