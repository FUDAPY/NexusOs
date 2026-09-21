/* ===================================================================
   NexusOS · Tiempo real (front)  —  Fase 4
   -------------------------------------------------------------------
   Reemplaza los `onSnapshot` de Firestore del dashboard y del POS.

   Por que NO se puede traducir onSnapshot 1:1 a Socket.IO:
   onSnapshot entrega el ESTADO de la coleccion. Socket.IO entrega
   EVENTOS ("paso algo"). Son cosas distintas. Por eso este modulo hace
   dos cosas separadas:
     1. avisa del evento puntual (para el KPI que se puede sumar al vuelo)
     2. dispara 'resync' cuando la conexion vuelve, para que la pagina
        vuelva a pedir los datos por HTTP y no quede con huecos de lo
        que paso mientras el socket estaba caido.

   Servidor: namespace '/kds', path '/realtime', room por sucursal.
   Los dashboards que ven todo escuchan la room 'unificado', que recibe
   copia de los eventos de todas las sucursales (ver sockets/kds.ts).

   Uso:
     <script src="nexus-api.js"></script>
     <script src="nexus-realtime.js"></script>
     await NexusRealtime.conectar({ sucursalId: 'Centro' });
     NexusRealtime.on('venta:creada', (e) => sumarAlTurno(e.total));
     NexusRealtime.on('resync', () => this.cargarResumenTurno());
   =================================================================== */
(function (global) {
  'use strict';

  var VERSION_CLIENTE = '4.8.1';

  
  var FUENTES_CLIENTE = [
    '/realtime/socket.io.min.js',
    '/socket.io/socket.io.js',
    'https://cdn.socket.io/' + VERSION_CLIENTE + '/socket.io.min.js',
  ];

  var EVENTOS = {
    'venta:creada': 'venta:creada',
    'venta:anulada': 'venta:anulada',
    'turno:abierto': 'turno:abierto',
    'turno:cerrado': 'turno:cerrado',
    'stock:cambiado': 'stock:cambiado',
  };

  var state = {
    socket: null,
    sucursalId: 'unificado',
    conectado: false,
    listeners: {},
    
    desconectadoDesde: null,
  };

  
  function emit(event, payload) {
    var subs = state.listeners[event];
    if (!subs) return;
    for (var i = 0; i < subs.length; i += 1) {
      try { subs[i](payload); } catch (e) {  }
    }
  }

  function on(event, handler) {
    if (!state.listeners[event]) state.listeners[event] = [];
    state.listeners[event].push(handler);
    return function off() {
      state.listeners[event] = state.listeners[event].filter(function (h) { return h !== handler; });
    };
  }

  
  function cargarScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(src); };
      s.onerror = function () { reject(new Error('No se pudo cargar ' + src)); };
      document.head.appendChild(s);
    });
  }

  function cargarCliente() {
    if (global.io) return Promise.resolve('ya estaba');


    return FUENTES_CLIENTE.reduce(function (cadena, src) {
      return cadena.catch(function () { return cargarScript(src); });
    }, Promise.reject(new Error('inicio')))
      .then(function (src) {
        if (!global.io) throw new Error('El script cargo pero no definio window.io');
        return src;
      });
  }

  
  
  function conectar(opciones) {
    var opts = opciones || {};
    state.sucursalId = opts.sucursalId ? String(opts.sucursalId) : 'unificado';

    if (state.socket) return Promise.resolve(state.socket);

    return cargarCliente().then(function () {
      var socket = global.io('/kds', {
        path: '/realtime',
        query: { sucursalId: state.sucursalId },
        auth: opts.token ? { token: opts.token } : undefined,

        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
        transports: ['websocket', 'polling'],
      });

      state.socket = socket;

      socket.on('connect', function () {
        var eraReconexion = state.desconectadoDesde !== null;
        state.conectado = true;
        emit('conectado', { id: socket.id, sucursalId: state.sucursalId });


        if (eraReconexion) {
          emit('resync', {
            motivo: 'reconexion',
            desde: state.desconectadoDesde,
            hasta: new Date().toISOString(),
          });
        }
        state.desconectadoDesde = null;
      });

      socket.on('disconnect', function (razon) {
        state.conectado = false;
        if (state.desconectadoDesde === null) state.desconectadoDesde = new Date().toISOString();
        emit('desconectado', { razon: razon });
      });

      socket.on('connect_error', function (error) {
        emit('error', {
          code: 'CONNECT_ERROR',
          message: error && error.message ? error.message : 'sin detalle',
        });
      });


      Object.keys(EVENTOS).forEach(function (nombre) {
        socket.on(nombre, function (payload) {
          emit(nombre, payload);
        });
      });

      return socket;
    });
  }

  function cerrar() {
    if (!state.socket) return;
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
    state.conectado = false;
    state.desconectadoDesde = null;
  }

  
  var NexusRealtime = {
    conectar: conectar,
    cerrar: cerrar,
    on: on,

    get conectado() { return state.conectado; },
    get sucursalId() { return state.sucursalId; },
    get socket() { return state.socket; },

    
    onVentaCreada: function (cb) { return on('venta:creada', cb); },
    onVentaAnulada: function (cb) { return on('venta:anulada', cb); },
    onTurnoAbierto: function (cb) { return on('turno:abierto', cb); },
    onTurnoCerrado: function (cb) { return on('turno:cerrado', cb); },
    onStockCambiado: function (cb) { return on('stock:cambiado', cb); },

    
    reconectar: function () {
      if (state.socket && !state.conectado) state.socket.connect();
    },

    eventos: Object.keys(EVENTOS),
  };

  global.NexusRealtime = NexusRealtime;

  
  if (global.addEventListener) {
    global.addEventListener('online', function () {
      NexusRealtime.reconectar();
    });
  }
})(window);
