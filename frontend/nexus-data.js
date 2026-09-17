/* ===================================================================
   NexusOS · Adaptador de datos (front)  —  Fase 4
   -------------------------------------------------------------------
   Da a las paginas una cara PARECIDA a Firestore sobre NexusAPI, para
   poder migrarlas de a una sin reescribirlas dos veces.

   -------------------------------------------------------------------
   INTERRUPTOR POR PAGINA
   -------------------------------------------------------------------
   Cada pagina elige su fuente sin tocar codigo:

     localStorage['nexus.fuente.dashboard'] = 'mongo' | 'firestore'

   Si no hay valor, se usa `NexusData.fuentePorDefecto` (por defecto
   'firestore', para no cambiar el comportamiento de golpe).

   Regla:  NexusData.esMongo() ? NexusData.leer(...) : <codigo Firestore viejo>
   Asi una pagina puede estar a medio migrar sin romperse.

   -------------------------------------------------------------------
   LO QUE ESTE MODULO *NO* HACE (y es a proposito)
   -------------------------------------------------------------------
   No imita onSnapshot. onSnapshot entrega el ESTADO de una coleccion;
   Socket.IO entrega EVENTOS. Se puede fingir con refetch, pero eso
   gasta una query por cada evento de cada cliente. Por eso `vigilar()`
   refetchea con un debounce y ademas escucha 'resync' de NexusRealtime:
   el resultado es el mismo dato, sin el coste de un onSnapshot por
   documento.

   Uso:
     await NexusData.leer('branches', { orderBy: ['nombre', 'asc'], limit: 100 });
     await NexusData.contar('users', { where: [['rol', '==', 'cliente']] });
     await NexusData.vigilar('cashFlows', { where: [['estadoTurno','==','abierto']] }, (filas) => pintar(filas));
   =================================================================== */
(function (global) {
  'use strict';

  /* ---------- Mapa Firestore -> API ----------
     Los nombres de la izquierda son los de Firestore, que son los que ya estan
     escritos en las paginas. Los de la derecha son las rutas reales montadas en
     server/src/routes. Se incluyen las dos convenciones porque el codigo viejo
     mezcla camelCase (cierresCaja) y snake_case (cash_shifts). */
  var COLECCIONES = {
    products: '/products',
    branches: '/branches',
    categories: '/categories',
    currencies: '/currencies',
    users: '/users',

    // El POS guarda las ventas en 'sales'; el backend las expone en /orders.
    sales: '/orders',
    orders: '/orders',

    // La caja: Firestore 'cashFlows' -> coleccion cash_shifts.
    cashFlows: '/cash-shifts',
    cash_shifts: '/cash-shifts',
    cashShifts: '/cash-shifts',

    // Los cierres Z: Firestore 'cierresCaja' -> coleccion cash_closes.
    cierresCaja: '/cash-closes',
    cash_closes: '/cash-closes',
    cashCloses: '/cash-closes',

    auditoria: '/audit-logs',
    audit_logs: '/audit-logs',
    auditLogs: '/audit-logs',

    productionBatches: '/production-batches',
    production_batches: '/production-batches',
    productionConfig: '/production-config',
    production_config: '/production-config',

    linTickets: '/lin-tickets',
    lin_tickets: '/lin-tickets',
    linTicketClaims: '/lin-ticket-claims',
    lin_ticket_claims: '/lin-ticket-claims',

    creditPins: '/credit-pins',
    credit_pins: '/credit-pins',
    creditPinAttempts: '/credit-pin-attempts',
    credit_pin_attempts: '/credit-pin-attempts',

    publicGoals: '/public-goals',
    public_goals: '/public-goals',
    supportAlerts: '/support-alerts',
    support_alerts: '/support-alerts',
    syncLogs: '/sync-logs',
    sync_logs: '/sync-logs',
    notifications: '/notifications',
    settings: '/settings',
  };

  var state = {
    /**
     * Fuente global si la pagina no define la suya.
     *
     * Es 'mongo' y no 'firestore' porque el dashboard YA esta migrado: las 9
     * lecturas que dependian de esto tienen su rama NexusData escrita, y con el
     * default en 'firestore' tomaban el camino viejo. Ese camino hoy no puede
     * funcionar (index.html dejo de autenticar contra Firebase, asi que
     * firestore.rules responde permission-denied) y el panel aparecia vacio con
     * errores de permisos en lugar de mostrar nada.
     *
     * El interruptor se conserva: una pagina a medio migrar puede forzar
     * 'firestore' con NexusData.usarMongo('pagina', false).
     */
    fuentePorDefecto: 'mongo',
    /** Colecciones con vigilancia activa, para saber que refetchear. */
    vigiladas: {},
  };

  function rutaDe(coleccion) {
    var ruta = COLECCIONES[coleccion];
    if (!ruta) {
      throw new Error(
        'NexusData: la coleccion "' + coleccion + '" no esta mapeada. ' +
        'Agregarla a COLECCIONES en nexus-data.js.'
      );
    }
    return ruta;
  }

  /* ---------- Interruptor ---------- */
  function claveDe(pagina) {
    return 'nexus.fuente.' + (pagina || 'global');
  }

  /**
   * Fuente efectiva de una pagina. `pagina` sale normalmente de
   * document.body.dataset.nexusPagina.
   */
  function fuente(pagina) {
    try {
      var guardado = global.localStorage ? global.localStorage.getItem(claveDe(pagina)) : null;
      if (guardado === 'mongo' || guardado === 'firestore') return guardado;
    } catch (e) { /* modo privado o storage bloqueado: se usa el default */ }
    return state.fuentePorDefecto;
  }

  function usarMongo(pagina, activar) {
    try {
      global.localStorage.setItem(claveDe(pagina), activar === false ? 'firestore' : 'mongo');
      return true;
    } catch (e) {
      return false;
    }
  }

  function esMongo(pagina) {
    return fuente(pagina) === 'mongo';
  }

  /* ---------- Traduccion de consultas ---------- */
  /**
   * Separa las opciones de transporte de las de consulta.
   * `fresh`, `ttl`, `timeout` y `retries` son de NexusAPI y no deben viajar como
   * query params.
   */
  function apiOptions(opts) {
    var api = {};
    if (opts.fresh !== undefined) api.fresh = opts.fresh;
    if (opts.ttl !== undefined) api.ttl = opts.ttl;
    if (opts.timeout !== undefined) api.timeout = opts.timeout;
    if (opts.retries !== undefined) api.retries = opts.retries;
    return api;
  }

  /**
   * Convierte el estilo Firestore a los query params del backend.
   *
   *   where:   [['campo','==','valor'], ['turnoId','in',[a, b]]]
   *   orderBy: ['fecha','desc']
   *
   * OJO al depurar: el backend solo reconoce los campos declarados en su lista
   * `filtros` (ver resource.routes.ts). Un `where` sobre un campo no declarado
   * NO da error: se ignora en silencio y la consulta devuelve de mas. Si una
   * pantalla muestra filas que no corresponden, el primer sospechoso es eso.
   */
  function aQuery(opciones) {
    var opts = opciones || {};
    var q = {};
    var where = opts.where || [];

    for (var i = 0; i < where.length; i += 1) {
      var terna = where[i] || [];
      var campo = terna[0];
      var op = terna[1];
      var valor = terna[2];
      if (!campo || valor === undefined || valor === null || valor === '') continue;

      if (op === '==') {
        q[campo] = valor;
      } else if (op === 'in') {
        if (!Array.isArray(valor) || valor.length === 0) continue;
        q[campo] = valor.join(',');
      } else if (op === '>=') {
        q.desde = valor;
      } else if (op === '<=') {
        q.hasta = valor;
      }
      // Los demas operadores (!=, >, <, array-contains, not-in) no tienen
      // equivalente en el backend. Se ignoran a proposito: devolver de mas y
      // que la pantalla lo note es preferible a devolver de menos en silencio.
    }

    if (opts.limit !== undefined) q.limit = opts.limit;
    if (opts.offset !== undefined) q.offset = opts.offset;
    if (opts.q !== undefined) q.q = opts.q;
    if (opts.orderBy) {
      var orden = Array.isArray(opts.orderBy) ? opts.orderBy : [opts.orderBy];
      q.sort = orden[0];
      q.order = orden[1] || 'desc';
    }
    return q;
  }

  /* ---------- Lectura ---------- */
  /**
   * TTL por defecto 0 (sin cache) salvo que se pida `cache: true`.
   *
   * NexusAPI cachea los GET 8 segundos, que esta bien para el catalogo pero no
   * para el turno en curso: despues de cobrar, el arqueo tiene que reflejar la
   * venta ya mismo. Para catalogos, pasar `{ cache: true }`.
   */
  function conTtl(opts, api) {
    if (api.ttl === undefined && opts.cache !== true) api.ttl = 0;
    return api;
  }

  /** Devuelve el sobre completo: { items, total, limit, offset }. */
  function leerPagina(coleccion, opciones) {
    var opts = opciones || {};
    var api = conTtl(opts, apiOptions(opts));
    return global.NexusAPI.get(rutaDe(coleccion), aQuery(opts), api).then(function (r) {
      var d = r.data;
      if (d && Array.isArray(d.items)) return d;
      var suelto = Array.isArray(d) ? d : [];
      return { items: suelto, total: suelto.length, limit: null, offset: 0 };
    });
  }

  /** Devuelve solo el array de filas, que es lo que usan las tablas. */
  function leer(coleccion, opciones) {
    return leerPagina(coleccion, opciones).then(function (pagina) {
      return pagina.items;
    });
  }

  /**
   * Conteo real. Pide limit=1 porque solo interesa `total`, que el backend
   * calcula con countDocuments y no con el tamaño de la pagina.
   */
  function contar(coleccion, opciones) {
    var opts = {};
    var origen = opciones || {};
    for (var k in origen) { if (Object.prototype.hasOwnProperty.call(origen, k)) opts[k] = origen[k]; }
    opts.limit = 1;
    return leerPagina(coleccion, opts).then(function (pagina) {
      return pagina.total;
    });
  }

  /** Una fila por id. */
  function obtener(coleccion, id, opciones) {
    var api = apiOptions(opciones || {});
    return global.NexusAPI.get(rutaDe(coleccion) + '/' + encodeURIComponent(id), undefined, api)
      .then(function (r) { return r.data; });
  }

  /* ---------- Escritura ---------- */
  /**
   * Colecciones donde el POST/PATCH generico NO sirve, con el motivo.
   * Se comprueba ANTES de llamar: sin esto el error que llegaria es un 404 de
   * "ruta no encontrada" que no explica nada.
   */
  var SIN_ESCRITURA_GENERICA = {
    auditoria: 'La auditoria la escribe el servidor (recordAudit), no el cliente.',
    audit_logs: 'La auditoria la escribe el servidor (recordAudit), no el cliente.',
    auditLogs: 'La auditoria la escribe el servidor (recordAudit), no el cliente.',
    settings: 'settings es solo lectura por API.',
    currencies: 'currencies es solo lectura por API.',
    creditPinAttempts: 'Los intentos de PIN los registra el servidor.',
    credit_pin_attempts: 'Los intentos de PIN los registra el servidor.',
    sales: 'Las ventas se crean con NexusAPI.orders.create (POST /orders), que es transaccional.',
    orders: 'Las ventas se crean con NexusAPI.orders.create (POST /orders), que es transaccional.',
  };

  function verificarEscritura(coleccion) {
    var motivo = SIN_ESCRITURA_GENERICA[coleccion];
    if (motivo) {
      throw new Error('NexusData: no se puede escribir en "' + coleccion + '" por la via generica. ' + motivo);
    }
  }

  function crear(coleccion, datos) {
    verificarEscritura(coleccion);
    return global.NexusAPI.post(rutaDe(coleccion), datos, { ttl: 0 }).then(function (r) { return r.data; });
  }

  function actualizar(coleccion, id, cambios) {
    verificarEscritura(coleccion);
    return global.NexusAPI.patch(rutaDe(coleccion) + '/' + encodeURIComponent(id), cambios, { ttl: 0 })
      .then(function (r) { return r.data; });
  }

  /**
   * Borra un documento.
   *
   * El CRUD generico NO expone DELETE: lo habilita cada coleccion en el backend
   * con `borrable: true` (ver resource.factory.ts). Si la coleccion no lo tiene,
   * la API responde 404/405 y el error llega tal cual, que es mejor que un
   * borrado silencioso en una coleccion de operacion.
   */
  function eliminar(coleccion, id) {
    verificarEscritura(coleccion);
    return global.NexusAPI.del(rutaDe(coleccion) + '/' + encodeURIComponent(id), { ttl: 0 })
      .then(function (r) { return r.data; });
  }

  /* ---------- Vigilancia (sustituto practico de onSnapshot) ---------- */
  /**
   * Lectura inicial + refetch con debounce ante cualquier evento de negocio.
   *
   * Por que NO hay un onSnapshot real: onSnapshot recibe el estado de la
   * coleccion desde el servidor; Socket.IO solo avisa que algo paso. Se podria
   * emitir el documento entero en cada evento, pero el listado tambien cambia
   * por orden, limites y conteos, asi que habria que rehacerlo igual. El
   * refetch con debounce da el mismo resultado y agrupa rafagas de eventos.
   *
   * Devuelve `detener()`.
   */
  function vigilar(coleccion, opciones, alCambiar) {
    var opts = opciones || {};
    var temporizador = null;
    var vivo = true;
    var espera = opts.debounceMs === undefined ? 400 : opts.debounceMs;

    function publicar() {
      if (!vivo) return;
      leer(coleccion, opts).then(function (filas) {
        if (vivo) alCambiar(filas);
      }).catch(function (err) {
        if (global.console) {
          console.warn('[NexusData] vigilar(' + coleccion + ') fallo:', err && err.message);
        }
      });
    }

    function agendar() {
      if (temporizador !== null) clearTimeout(temporizador);
      temporizador = setTimeout(function () {
        temporizador = null;
        publicar();
      }, espera);
    }

    var desuscribir = [];
    if (global.NexusRealtime) {
      desuscribir.push(global.NexusRealtime.on('resync', agendar));
      // Cualquiera de los 5 eventos puede mover la coleccion vigilada. No se
      // intenta adivinar cual: el refetch es barato y el debounce los agrupa.
      global.NexusRealtime.eventos.forEach(function (ev) {
        desuscribir.push(global.NexusRealtime.on(ev, agendar));
      });
    }

    publicar();

    return function detener() {
      vivo = false;
      if (temporizador !== null) clearTimeout(temporizador);
      for (var i = 0; i < desuscribir.length; i += 1) {
        try { desuscribir[i](); } catch (e) { /* ya desuscripto */ }
      }
      desuscribir = [];
    };
  }

  global.NexusData = {
    /* mapa y rutas */
    COLECCIONES: COLECCIONES,
    rutaDe: rutaDe,

    /* interruptor por pagina */
    fuente: fuente,
    esMongo: esMongo,
    usarMongo: usarMongo,
    claveDe: claveDe,
    get fuentePorDefecto() { return state.fuentePorDefecto; },
    set fuentePorDefecto(valor) {
      state.fuentePorDefecto = valor === 'mongo' ? 'mongo' : 'firestore';
    },

    /* traduccion de consultas (util para depurar en consola) */
    aQuery: aQuery,

    /* lectura */
    leer: leer,
    leerPagina: leerPagina,
    contar: contar,
    obtener: obtener,

    /* escritura */
    crear: crear,
    actualizar: actualizar,
    eliminar: eliminar,
    SIN_ESCRITURA_GENERICA: SIN_ESCRITURA_GENERICA,

    /* tiempo real */
    vigilar: vigilar,
  };
})(window);
