/**
 * SISTEMA DE LOGGING
 * Para debugging en producción
 */

const Logger = {
    // Niveles
    NIVELES: {
        DEBUG: 0,
        INFO: 1,
        WARN: 2,
        ERROR: 3
    },

    _nivelActual: 1, // Por defecto INFO
    _logs: [],
    _maxLogs: 1000,

    inicializar: function(nivel = 'INFO') {
        this._nivelActual = this.NIVELES[nivel] || 1;
        console.log(`Logger inicializado - Nivel: ${nivel}`);
    },

    debug: function(mensaje, datos = null) {
        this._log('DEBUG', mensaje, datos, 0);
    },

    info: function(mensaje, datos = null) {
        this._log('INFO', mensaje, datos, 1);
    },

    warn: function(mensaje, datos = null) {
        this._log('WARN', mensaje, datos, 2);
    },

    error: function(mensaje, datos = null) {
        this._log('ERROR', mensaje, datos, 3);
    },

    _log: function(nivel, mensaje, datos, nivelNumerico) {
        if (nivelNumerico < this._nivelActual) return;

        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            nivel,
            mensaje,
            datos,
            url: window.location.href
        };

        // Almacenar localmente
        this._logs.push(logEntry);
        if (this._logs.length > this._maxLogs) {
            this._logs.shift();
        }

        // Imprimir en consola
        const estilos = {
            DEBUG: 'color: #666; font-size: 12px;',
            INFO: 'color: #2563eb; font-weight: bold;',
            WARN: 'color: #f59e0b; font-weight: bold;',
            ERROR: 'color: #dc2626; font-weight: bold;'
        };

        console.log(`%c[${nivel}] ${timestamp}: ${mensaje}`, estilos[nivel], datos || '');
    },

    obtenerLogs: function() {
        return this._logs;
    },

    limpiarLogs: function() {
        this._logs = [];
    },

    descargarLogs: function() {
        const contenido = JSON.stringify(this._logs, null, 2);
        Utils.descargarArchivo(contenido, `logs_${Date.now()}.json`);
    },

    // Enviar logs al servidor (si lo necesitas para debugging remoto)
    enviarLogsAlServidor: async function(endpoint) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    usuario: auth.currentUser?.uid,
                    logs: this._logs,
                    timestamp: new Date().getTime()
                })
            });
            if (response.ok) {
                this.info('Logs enviados al servidor');
                this.limpiarLogs();
            }
        } catch (e) {
            this.error('Error enviando logs:', e);
        }
    }
};

// Inicializar automáticamente
if (typeof window !== 'undefined') {
    Logger.inicializar();
}
