/* ===================================================================
   NexusOS · Selector de tema (claro / oscuro)
   -------------------------------------------------------------------
   Cargar en <head> SIN defer y ANTES de nexus-api.js: asi el atributo
   data-theme queda puesto antes del primer pintado y no hay destello
   blanco al abrir una pagina en modo oscuro.

   El tema se aplica a <html>:
       <html>                     -> oscuro (por defecto)
       <html data-theme="light">  -> claro

   Todo nexus-theme.css remapea clases a var(--nx-*) y nexus.css
   redefine esos tokens bajo [data-theme="light"], asi que este script
   no toca ningun color: solo cambia el atributo.

   La preferencia se guarda en localStorage y, la primera vez, se toma
   la del sistema operativo (prefers-color-scheme).
   =================================================================== */
(function () {
  'use strict';

  var KEY = 'nexus.tema';
  var root = document.documentElement;

  function leerGuardado() {
    try {
      var v = window.localStorage.getItem(KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) {
      return null;
    }
  }

  function preferenciaDelSistema() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
      }
    } catch (e) { /* ignorar */ }
    return 'dark';
  }

  function aplicar(tema) {
    if (tema === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
    // color-scheme hace que el navegador pinte bien los controles nativos
    // (scrollbar, input date, select) sin necesidad de hacks con filter.
    root.style.colorScheme = tema;
  }

  function guardar(tema) {
    try {
      window.localStorage.setItem(KEY, tema);
    } catch (e) { /* modo privado: sigue funcionando, solo no persiste */ }
  }

  var actual = leerGuardado() || preferenciaDelSistema();
  aplicar(actual);   // <- se ejecuta antes del primer pintado

  function esClaro() {
    return root.getAttribute('data-theme') === 'light';
  }

  function pintarBoton(boton) {
    var claro = esClaro();
    boton.innerHTML = '<i class="fa-solid ' + (claro ? 'fa-moon' : 'fa-sun') + '"></i>';
    boton.setAttribute('aria-label', claro ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro');
    boton.setAttribute('title', claro ? 'Pasar a modo oscuro' : 'Pasar a modo claro');
  }

  function alternar() {
    actual = esClaro() ? 'dark' : 'light';
    aplicar(actual);
    guardar(actual);
    var b = document.querySelector('.nx-theme-toggle');
    if (b) pintarBoton(b);
  }

  function crearBoton() {
    if (document.querySelector('.nx-theme-toggle')) return;
    if (!document.body) return;

    var boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'nx-theme-toggle';
    boton.addEventListener('click', alternar);
    document.body.appendChild(boton);
    pintarBoton(boton);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', crearBoton);
  } else {
    crearBoton();
  }

  // API publica por si alguna pagina quiere leer o forzar el tema.
  window.NexusTema = {
    actual: function () { return actual; },
    alternar: alternar,
    poner: function (tema) {
      actual = (tema === 'light') ? 'light' : 'dark';
      aplicar(actual);
      guardar(actual);
      var b = document.querySelector('.nx-theme-toggle');
      if (b) pintarBoton(b);
    },
  };
})();
