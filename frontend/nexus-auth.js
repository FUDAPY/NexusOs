/* ===================================================================
   NexusOS · Autenticacion (front)  —  Fase 5
   -------------------------------------------------------------------
   Reemplaza a firebase.auth manteniendo EXACTAMENTE la misma sesion que
   la app ya usa en localStorage['__pos_session']:

     { uid, email, nombre, rol, sucursal }

   Eso es a proposito: redirigirPorRol(), la barra lateral y el guard de
   sesion leen esa clave y esa forma. Al respetarlas, todo eso sigue
   funcionando sin tocarlo; solo cambia de donde sale el dato.

   El backend devuelve { id, nombre, email, rol, sucursal, requierePassword },
   asi que la unica traduccion es id -> uid.

   El JWT vive en localStorage['__pos_token'] y se inyecta en NexusAPI, que
   ya sabe mandarlo como `Authorization: Bearer`.

   Uso:
     await NexusAuth.entrar(email, password);   // deja la sesion lista
     NexusAuth.sesion();                        // {uid,email,nombre,rol,sucursal}
     NexusAuth.salir();
   =================================================================== */
(function (global) {
  'use strict';

  var CLAVE_SESION = '__pos_session';
  var CLAVE_TOKEN = '__pos_token';

  
  
  function leerClave(clave) {
    try {
      return global.localStorage ? global.localStorage.getItem(clave) : null;
    } catch (e) {
      return null;
    }
  }

  function escribirClave(clave, valor) {
    try {
      if (global.localStorage) global.localStorage.setItem(clave, valor);
      return true;
    } catch (e) {
      return false;
    }
  }

  function borrarClave(clave) {
    try {
      if (global.localStorage) global.localStorage.removeItem(clave);
    } catch (e) {  }
  }

  
  function sesion() {
    var crudo = leerClave(CLAVE_SESION);
    if (!crudo) return null;
    try {
      var s = JSON.parse(crudo);
      if (!s || !s.uid || !s.rol) return null;
      return s;
    } catch (e) {

      borrarClave(CLAVE_SESION);
      return null;
    }
  }

  function token() {
    return leerClave(CLAVE_TOKEN);
  }

  function usuarioId() {
    var s = sesion();
    return s ? s.uid : null;
  }

  function autenticado() {
    return token() !== null && sesion() !== null;
  }

  
  function aSesionLocal(usuario) {
    return {
      uid: String(usuario.id || ''),
      email: usuario.email || '',
      nombre: usuario.nombre || 'Usuario',
      rol: usuario.rol || 'cliente',
      sucursal: usuario.sucursal || 'Centro',
    };
  }

  function guardarSesion(respuesta) {
    var s = aSesionLocal(respuesta.usuario);
    escribirClave(CLAVE_SESION, JSON.stringify(s));
    escribirClave(CLAVE_TOKEN, respuesta.token);
    if (global.NexusAPI) global.NexusAPI.token = respuesta.token;
    return s;
  }

  
  function rehidratar() {
    var t = token();
    if (t !== null && global.NexusAPI) global.NexusAPI.token = t;
    return autenticado();
  }

  function salir() {
    borrarClave(CLAVE_SESION);
    borrarClave(CLAVE_TOKEN);
    if (global.NexusAPI) {
      global.NexusAPI.token = null;
      if (global.NexusAPI.clearCache) global.NexusAPI.clearCache();
    }
  }

  
  global.NexusAuth = {
    CLAVE_SESION: CLAVE_SESION,
    CLAVE_TOKEN: CLAVE_TOKEN,

    sesion: sesion,
    token: token,
    usuarioId: usuarioId,
    autenticado: autenticado,
    rehidratar: rehidratar,
    salir: salir,
    aSesionLocal: aSesionLocal,
  };


  
  
  var MENSAJES = {
    CREDENCIALES_INVALIDAS: 'Correo o contrasena incorrectos.',
    EMAIL_EN_USO: 'Este correo ya esta registrado. Inicia sesion en lugar de crear la cuenta.',
    FALTAN_DATOS: 'Faltan datos obligatorios para crear la cuenta.',
    EMAIL_INVALIDO: 'El correo no tiene un formato valido.',
    PASSWORD_CORTA: 'La contrasena tiene que tener al menos 6 caracteres.',
    NOMBRE_CORTO: 'El nombre tiene que tener al menos 3 caracteres.',
    REQUIERE_PASSWORD: 'Esta cuenta todavia no tiene contrasena. Pedile al administrador que te la asigne para poder entrar.',
    DEMASIADOS_INTENTOS: 'Demasiados intentos fallidos. Espera unos minutos antes de reintentar.',
    MISSING_EMAIL: 'Escribi tu correo.',
    MISSING_PASSWORD: 'Escribi tu contrasena.',
    NETWORK: 'No pudimos conectar con el servidor. Revisa internet.',
    TIMEOUT: 'El servidor tardo demasiado en responder.',
    SIN_TOKEN: 'Tu sesion vencio. Volve a entrar.',
    TOKEN_INVALIDO: 'Tu sesion vencio. Volve a entrar.',
  };

  function mensajeDe(error) {
    var codigo = (error && error.code) || '';
    if (MENSAJES[codigo]) return MENSAJES[codigo];
    if (error && error.status === 429) return MENSAJES.DEMASIADOS_INTENTOS;
    if (error && error.message) return error.message;
    return 'No se pudo iniciar sesion.';
  }

  
  function entrar(email, password) {
    var correo = String(email || '').trim().toLowerCase();
    var clave = String(password || '');

    if (correo === '') return rechazar('MISSING_EMAIL', MENSAJES.MISSING_EMAIL);
    if (clave === '') return rechazar('MISSING_PASSWORD', MENSAJES.MISSING_PASSWORD);

    if (!global.NexusAPI) {
      return rechazar('SIN_NEXUSAPI', 'NexusAPI no esta cargado: falta <script src="nexus-api.js">.');
    }


    return global.NexusAPI.post('/auth/login', { email: correo, password: clave }, { ttl: 0, retries: 0 })
      .then(function (r) {
        return guardarSesion(r.data);
      });
  }

  function rechazar(codigo, mensaje) {
    var e = new Error(mensaje);
    e.code = codigo;
    return Promise.reject(e);
  }

  
  function registrar(datos) {
    if (!global.NexusAPI) {
      return rechazar('SIN_NEXUSAPI', 'NexusAPI no esta cargado: falta <script src="nexus-api.js">.');
    }
    return global.NexusAPI.post('/auth/registro', datos, { ttl: 0, retries: 0 })
      .then(function (r) {
        return guardarSesion(r.data);
      });
  }

  
  
  function cambiarNombre(nombre) {
    if (!sesion()) return rechazar('SIN_SESION', 'No hay sesion iniciada.');
    return global.NexusAPI.patch('/auth/perfil', { nombre: nombre }, { ttl: 0 })
      .then(function (r) {
        var actualizada = aSesionLocal(r.data);
        escribirClave(CLAVE_SESION, JSON.stringify(actualizada));
        return actualizada;
      });
  }

  
  function cambiarPassword(actual, nueva) {
    var cuerpo = { nueva: nueva };
    if (actual !== undefined && actual !== null && actual !== '') cuerpo.actual = actual;
    return global.NexusAPI.post('/auth/password', cuerpo, { ttl: 0 }).then(function (r) {
      return r.data;
    });
  }

  
  function perfil() {
    return global.NexusAPI.get('/auth/perfil', undefined, { ttl: 0 }).then(function (r) {
      return r.data;
    });
  }

  
  function cerrarSesion() {
    salir();
    if (global.location) global.location.replace('index.html');
  }

  global.NexusAuth.entrar = entrar;
  global.NexusAuth.registrar = registrar;
  global.NexusAuth.cerrarSesion = cerrarSesion;
  global.NexusAuth.cambiarNombre = cambiarNombre;
  global.NexusAuth.cambiarPassword = cambiarPassword;
  global.NexusAuth.perfil = perfil;
  global.NexusAuth.mensajeDe = mensajeDe;
  global.NexusAuth.MENSAJES = MENSAJES;


  // con el token puesto en NexusAPI sin tener que llamar nada.
  rehidratar();
})(window);
