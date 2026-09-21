
(function (global) {
  'use strict';

  
  var COLECCIONES = {
    products: '/products',
    branches: '/branches',
    categories: '/categories',
    currencies: '/currencies',
    users: '/users',


    sales: '/orders',
    orders: '/orders',


    cashFlows: '/cash-shifts',
    cash_shifts: '/cash-shifts',
    cashShifts: '/cash-shifts',
    'cash-flows': '/cash-shifts',
    'cash-shifts': '/cash-shifts',


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
    'production-config': '/production-config',
    'production-batches': '/production-batches',

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
    'public-goals': '/public-goals',
    supportAlerts: '/support-alerts',
    support_alerts: '/support-alerts',
    syncLogs: '/sync-logs',
    sync_logs: '/sync-logs',
    'sync-logs': '/sync-logs',
    inventoryMovements: '/inventory-movements',
    inventory_movements: '/inventory-movements',
    'inventory-movements': '/inventory-movements',
    notifications: '/notifications',
    settings: '/settings',
  };

  var state = {
    
    fuentePorDefecto: 'mongo',
    
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

  
  function claveDe(pagina) {
    return 'nexus.fuente.' + (pagina || 'global');
  }

  
  function fuente(pagina) {
    try {
      var guardado = global.localStorage ? global.localStorage.getItem(claveDe(pagina)) : null;

      /* Un 'firestore' guardado NO se respeta mas.
         Firestore ya no autoriza: esa rama no es "el comportamiento anterior", es codigo
         muerto que deja la pantalla vacia. Y quedaba PEGADO en el navegador: una maquina
         con la clave vieja seguia mostrando un panel sin datos aunque todo lo demas
         estuviera migrado, que es exactamente el sintoma de "no esta conectado".
         Se corrige solo: si lo guardado dice 'firestore' y el defecto es 'mongo', se
         sobrescribe. Asi cualquier navegador con la clave vieja queda arreglado en la
         primera recarga, sin que nadie tenga que limpiar el storage a mano. */
      if (guardado === 'firestore' && state.fuentePorDefecto === 'mongo') {
        try {
          global.localStorage.setItem(claveDe(pagina), 'mongo');
        } catch (e) {  }
        return 'mongo';
      }

      if (guardado === 'mongo' || guardado === 'firestore') return guardado;
    } catch (e) {  }
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

  
  var ultimoLeerTodo = null;

  
  function leerTodo(coleccion, opciones, opcionesApi) {
    var opts = opciones || {};
    var porPagina = Math.min(Number(opts.limit) || 500, 500);
    var maxPaginas = Number(opts.maxPaginas) || 40;
    var acumulado = [];
    var paginas = 0;
    var trunco = false;

    var siguiente = function (offset) {
      return leer(
        coleccion,
        Object.assign({}, opts, { limit: porPagina, offset: offset }),
        opcionesApi,
      ).then(function (filas) {
        var lote = Array.isArray(filas) ? filas : [];
        acumulado = acumulado.concat(lote);
        paginas += 1;
        if (lote.length < porPagina) return acumulado;
        if (paginas >= maxPaginas) {
          trunco = true;
          return acumulado;
        }
        return siguiente(offset + porPagina);
      });
    };

    return siguiente(0).then(function (filas) {
      ultimoLeerTodo = { coleccion: coleccion, filas: filas.length, paginas: paginas, trunco: trunco };
      return filas;
    });
  }

  
  
  function apiOptions(opts) {
    var api = {};
    if (opts.fresh !== undefined) api.fresh = opts.fresh;
    if (opts.ttl !== undefined) api.ttl = opts.ttl;
    if (opts.timeout !== undefined) api.timeout = opts.timeout;
    if (opts.retries !== undefined) api.retries = opts.retries;
    return api;
  }

  
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

  
  
  function conTtl(opts, api) {
    if (api.ttl === undefined && opts.cache !== true) api.ttl = 0;
    return api;
  }

  
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

  
  function leer(coleccion, opciones) {
    return leerPagina(coleccion, opciones).then(function (pagina) {
      return pagina.items;
    });
  }

  
  function contar(coleccion, opciones) {
    var opts = {};
    var origen = opciones || {};
    for (var k in origen) { if (Object.prototype.hasOwnProperty.call(origen, k)) opts[k] = origen[k]; }
    opts.limit = 1;
    return leerPagina(coleccion, opts).then(function (pagina) {
      return pagina.total;
    });
  }

  
  function obtener(coleccion, id, opciones) {
    var api = apiOptions(opciones || {});
    return global.NexusAPI.get(rutaDe(coleccion) + '/' + encodeURIComponent(id), undefined, api)
      .then(function (r) { return r.data; });
  }

  
  
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

  
  function eliminar(coleccion, id) {
    verificarEscritura(coleccion);
    return global.NexusAPI.del(rutaDe(coleccion) + '/' + encodeURIComponent(id), { ttl: 0 })
      .then(function (r) { return r.data; });
  }

  
  
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

      global.NexusRealtime.eventos.forEach(function (ev) {
        desuscribir.push(global.NexusRealtime.on(ev, agendar));
      });
    }

    publicar();

    return function detener() {
      vivo = false;
      if (temporizador !== null) clearTimeout(temporizador);
      for (var i = 0; i < desuscribir.length; i += 1) {
        try { desuscribir[i](); } catch (e) {  }
      }
      desuscribir = [];
    };
  }

  
  function aSnapshot(filas) {
    var docs = [];
    for (var i = 0; i < filas.length; i += 1) {
      var fila = filas[i];
      docs.push({
        id: String(fila.uid || fila._id || ''),

        data: (function (f) { return function () { return f; }; })(fila),
      });
    }
    return {

      docs: docs,
      forEach: function (cb) {
        for (var j = 0; j < docs.length; j += 1) cb(docs[j]);
      },

      docChanges: function () { return []; },
      size: docs.length,
    };
  }

  
  function vigilarComoFirestore(coleccion, opciones, alCambiar) {
    return vigilar(coleccion, opciones || {}, function (filas) {
      alCambiar(aSnapshot(filas));
    });
  }

  global.NexusData = {
    
    COLECCIONES: COLECCIONES,
    rutaDe: rutaDe,

    
    fuente: fuente,
    esMongo: esMongo,
    usarMongo: usarMongo,
    claveDe: claveDe,
    leerTodo: leerTodo,
    get ultimoLeerTodo() { return ultimoLeerTodo; },
    get fuentePorDefecto() { return state.fuentePorDefecto; },
    set fuentePorDefecto(valor) {
      state.fuentePorDefecto = valor === 'mongo' ? 'mongo' : 'firestore';
    },

    
    aQuery: aQuery,

    
    leer: leer,
    leerPagina: leerPagina,
    contar: contar,
    obtener: obtener,

    
    crear: crear,
    actualizar: actualizar,
    eliminar: eliminar,
    SIN_ESCRITURA_GENERICA: SIN_ESCRITURA_GENERICA,

    
    vigilar: vigilar,
    
    vigilarComoFirestore: vigilarComoFirestore,
    
    aSnapshot: aSnapshot,
  };
})(window);
