/* ===================================================================
   NexusOS · Capa de acceso a datos (front <-> back)
   -------------------------------------------------------------------
   Punto unico de salida HTTP para todo el frontend. Reemplaza las
   llamadas dispersas a Firestore por un cliente con:
     - contrato { success, data } | { success: false, error, code }
     - timeout con AbortController y reintentos con backoff
     - deduplicacion de GET simultaneos y cache con TTL
     - deteccion de conexion (online/offline) y sondeo de /health
     - eventos para que las paginas reaccionen sin polling

   Uso:
     const { data } = await NexusAPI.orders.list({ branchId: 'x' });
     NexusAPI.on('offline', () => banner.classList.remove('hidden'));

   Configuracion (opcional, antes de cargar el script):
     window.NEXUS_API_BASE = 'https://app.tudominio.com/api/v1';
     o bien  <meta name="nexus-api-base" content="...">
   Por defecto usa el mismo origen: /api/v1
   =================================================================== */
(function (global) {
  'use strict';

  var DEFAULT_PREFIX = '/api/v1';
  var TIMEOUT_MS = 15000;
  var RETRIES = 2;
  var GET_CACHE_TTL_MS = 8000;

  
  function resolveBase() {
    if (global.NEXUS_API_BASE) return String(global.NEXUS_API_BASE).replace(/\/+$/, '');
    var meta = document.querySelector('meta[name="nexus-api-base"]');
    if (meta && meta.content) return meta.content.replace(/\/+$/, '');
    return global.location.origin + DEFAULT_PREFIX;
  }

  
  function NexusError(message, options) {
    var opts = options || {};
    var err = new Error(message);
    err.name = 'NexusError';
    err.code = opts.code || 'NEXUS_ERROR';
    err.status = opts.status || 0;
    err.details = opts.details;
    err.retryable = opts.retryable === true;
    return err;
  }

  
  var state = {
    base: resolveBase(),
    token: null,
    online: global.navigator ? global.navigator.onLine !== false : true,
    inflight: {},
    cache: {},
    listeners: {},
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

  
  function nowMs() { return Date.now(); }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function stableKey(method, url, body) {
    return method + ' ' + url + ' ' + (body === undefined ? '' : JSON.stringify(body));
  }

  function buildUrl(path, query) {
    var url = state.base + (path.charAt(0) === '/' ? path : '/' + path);
    if (!query) return url;
    var parts = [];
    Object.keys(query).forEach(function (k) {
      var v = query[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? url + '?' + parts.join('&') : url;
  }

  function markOnline(value) {
    if (state.online === value) return;
    state.online = value;
    emit(value ? 'online' : 'offline', { at: nowMs() });
  }

  if (global.addEventListener) {
    global.addEventListener('online', function () { markOnline(true); });
    global.addEventListener('offline', function () { markOnline(false); });
  }

  
  function doFetch(url, method, body, timeoutMs) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;

    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    var opts = { method: method, headers: headers, credentials: 'same-origin' };
    if (controller) opts.signal = controller.signal;
    if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

    var pending = fetch(url, opts);

    if (controller) {
      var timeout = new Promise(function (_resolve, reject) {
        timer = setTimeout(function () {
          controller.abort();
          reject(NexusError('Tiempo de espera agotado (' + timeoutMs + ' ms)', {
            code: 'TIMEOUT', retryable: true,
          }));
        }, timeoutMs);
      });
      pending = Promise.race([pending, timeout]);
    }

    return Promise.resolve(pending).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) {
        var payload = null;
        if (text) { try { payload = JSON.parse(text); } catch (e) { payload = null; } }

        if (res.ok && payload && payload.success === true) {
          return { data: payload.data, status: res.status };
        }

        var message = (payload && payload.error) ? payload.error : ('HTTP ' + res.status);
        var code = (payload && payload.code) ? payload.code : ('HTTP_' + res.status);

        return Promise.reject(NexusError(message, {
          code: code,
          status: res.status,
          details: payload,
          retryable: res.status >= 500 || res.status === 429,
        }));
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'NexusError') throw err;
      if (err && err.name === 'AbortError') {
        throw NexusError('Peticion cancelada', { code: 'ABORTED' });
      }
      markOnline(false);
      throw NexusError('No se pudo contactar el servidor', {
        code: 'NETWORK', status: 0, retryable: true, details: err,
      });
    });
  }

  
  function request(path, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var url = buildUrl(path, opts.query);
    var key = stableKey(method, url, opts.body);
    var timeoutMs = opts.timeout || TIMEOUT_MS;
    var retries = (opts.retries === undefined) ? RETRIES : opts.retries;
    var ttl = (opts.ttl === undefined) ? (method === 'GET' ? GET_CACHE_TTL_MS : 0) : opts.ttl;

    if (method === 'GET' && !opts.fresh) {
      var hit = state.cache[key];
      if (hit && hit.expires > nowMs()) return Promise.resolve(hit.value);
      if (state.inflight[key]) return state.inflight[key];
    }

    var attempt = 0;
    function run() {
      attempt += 1;
      return doFetch(url, method, opts.body, timeoutMs).then(function (result) {
        markOnline(true);
        if (ttl > 0) state.cache[key] = { expires: nowMs() + ttl, value: result };
        emit('request', { method: method, url: url, status: result.status, attempt: attempt });
        return result;
      }).catch(function (err) {
        if (err && err.retryable && attempt <= retries) {
          return sleep(250 * Math.pow(2, attempt - 1)).then(run);
        }
        emit('error', { method: method, url: url, error: err });
        throw err;
      });
    }

    var promise = run();
    if (method === 'GET') {
      state.inflight[key] = promise;
      var clear = function () { delete state.inflight[key]; };
      promise.then(clear, clear);
    }
    return promise;
  }

  
  var healthCache = { expires: 0, value: null };

  function healthRoot() {
    var m = state.base.match(/^(https?:\/\/[^/]+)/);
    return m ? m[1] : state.base;
  }

  function health(options) {
    var opts = options || {};
    var ttl = (opts.ttl === undefined) ? 20000 : opts.ttl;
    if (!opts.fresh && healthCache.value && healthCache.expires > nowMs()) {
      return Promise.resolve(healthCache.value);
    }
    return doFetch(healthRoot() + '/health', 'GET', undefined, opts.timeout || 5000)
      .then(function (result) {
        var info = {
          ok: !!(result.data && result.data.status === 'ok'),
          uptime: result.data ? result.data.uptime : null,
          checkedAt: nowMs(),
          base: state.base,
        };
        healthCache = { expires: nowMs() + ttl, value: info };
        emit('health', info);
        return info;
      })
      .catch(function (err) {
        var down = { ok: false, error: err.code, checkedAt: nowMs(), base: state.base };
        healthCache = { expires: nowMs() + ttl, value: down };
        emit('health', down);
        return down;
      });
  }

  
  function get(path, query, options) {
    var opts = options || {};
    opts.method = 'GET';
    opts.query = query;
    return request(path, opts);
  }

  function post(path, body, options) {
    var opts = options || {};
    opts.method = 'POST';
    opts.body = body;
    return request(path, opts);
  }

  function patch(path, body, options) {
    var opts = options || {};
    opts.method = 'PATCH';
    opts.body = body;
    return request(path, opts);
  }

  
  function del(path, options) {
    var opts = options || {};
    opts.method = 'DELETE';
    return request(path, opts);
  }

  
  var orders = {
    list: function (query, options) { return get('/orders', query, options); },
    create: function (payload, options) { return post('/orders', payload, options); },
    setKdsState: function (id, estado, options) {
      return patch('/orders/' + encodeURIComponent(id) + '/cocina', { estadoCocina: estado }, options);
    },
  };

  var auditLogs = {
    list: function (query, options) { return get('/audit-logs', query, options); },
  };

  
  var NexusAPI = {
    
    get base() { return state.base; },
    set base(value) { state.base = String(value).replace(/\/+$/, ''); },
    get token() { return state.token; },
    set token(value) { state.token = value || null; },
    get online() { return state.online; },
    health: health,
    config: { timeoutMs: TIMEOUT_MS, retries: RETRIES, getCacheTtlMs: GET_CACHE_TTL_MS },

    
    request: request,
    get: get, post: post, patch: patch, del: del,
    on: on,

    
    checkConnection: function () { return health({ fresh: true }); },
    clearCache: function () { state.cache = {}; healthCache = { expires: 0, value: null }; },
    isRetryable: function (err) { return !!(err && err.retryable); },

    
    orders: orders,
    auditLogs: auditLogs,
  };

  global.NexusAPI = NexusAPI;

  
  global.nexusApiReady = Promise.resolve(NexusAPI);
})(window);
