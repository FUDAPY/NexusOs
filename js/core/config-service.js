/**
 * SERVICIO DE CONFIGURACIÓN
 * Maneja divisas, límites de crédito, descuentos, etc.
 */

const ConfigService = {
    // Variables locales
    _config: null,
    _unsubscribe: null,

    // Inicializar servicio
    inicializar: async function() {
        try {
            // Cargar configuración desde Firestore en tiempo real
            this._unsubscribe = db.collection('config').doc('sistema').onSnapshot(
                (doc) => {
                    if (doc.exists) {
                        this._config = doc.data();
                        console.log('Config actualizada:', this._config);
                    } else {
                        // Crear config por defecto
                        this._crearConfigPorDefecto();
                    }
                },
                (error) => console.error('Error loading config:', error)
            );
        } catch (e) {
            console.error('Error inicializar ConfigService:', e);
            this._crearConfigPorDefecto();
        }
    },

    // Crear configuración por defecto
    _crearConfigPorDefecto: async function() {
        this._config = {
            divisas: {
                PYG: 1,           // Base
                USD: 6500,        // 1 USD = 6500 PYG
                ARS: 65,          // 1 ARS = 65 PYG
                BRL: 1300         // 1 BRL = 1300 PYG
            },
            creditoMaximoCliente: 500000, // Gs. 500.000
            descuentosProductos: {
                '30%': 0.30,
                '40%': 0.40,
                '50%': 0.50,
                '100%': 1.00      // Gratis
            },
            fechaActualizacionCambio: new Date().getTime()
        };

        try {
            await db.collection('config').doc('sistema').set(this._config);
            console.log('Config por defecto creada');
        } catch (e) {
            console.error('Error creando config por defecto:', e);
        }
    },

    // Obtener tasas de cambio
    obtenerTasasCambio: function() {
        return this._config?.divisas || { PYG: 1, USD: 6500, ARS: 65, BRL: 1300 };
    },

    // Actualizar tasa de cambio (solo admin)
    actualizarTasaCambio: async function(divisa, nuevaTasa) {
        try {
            const tasas = this.obtenerTasasCambio();
            tasas[divisa] = nuevaTasa;

            await db.collection('config').doc('sistema').update({
                'divisas': tasas,
                'fechaActualizacionCambio': new Date().getTime()
            });

            Utils.mostrarToast(`Tasa ${divisa} actualizada a ${nuevaTasa}`, 'success');
            return true;
        } catch (e) {
            console.error('Error actualizar tasa:', e);
            Utils.mostrarToast('Error al actualizar tasa', 'error');
            return false;
        }
    },

    // Obtener límite de crédito
    obtenerLimiteCreditoCliente: function() {
        return this._config?.creditoMaximoCliente || 500000;
    },

    // Actualizar límite de crédito (solo admin)
    actualizarLimiteCreditoCliente: async function(nuevoLimite) {
        try {
            await db.collection('config').doc('sistema').update({
                'creditoMaximoCliente': nuevoLimite
            });
            Utils.mostrarToast('Límite de crédito actualizado', 'success');
            return true;
        } catch (e) {
            console.error('Error actualizar límite:', e);
            Utils.mostrarToast('Error al actualizar límite', 'error');
            return false;
        }
    },

    // Obtener descuento de producto
    obtenerDescuentoProducto: function(porcentajeKey) {
        return this._config?.descuentosProductos?.[porcentajeKey] || 0;
    },

    // Obtener configuración completa
    obtenerConfig: function() {
        return this._config || {};
    },

    // Limpiar listeners
    limpiar: function() {
        if (this._unsubscribe) {
            this._unsubscribe();
        }
    }
};

// Iniciar cuando esté disponible
if (typeof db !== 'undefined') {
    ConfigService.inicializar();
}
