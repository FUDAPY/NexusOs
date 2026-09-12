/**
 * UTILIDADES COMPARTIDAS
 * Funciones reutilizables para todo el sistema
 */

// ============== FORMATEO Y CONVERSIÓN ==============
const Utils = {
    // Formatear moneda guaraní
    formatoMoneda: (valor) => {
        if (!valor) return 'Gs. 0';
        return `Gs. ${Math.round(valor).toLocaleString('es-PY')}`;
    },

    // Formatear con símbolo de divisa
    formatoDivisa: (valor, divisa = 'PYG') => {
        const simbolos = { PYG: 'Gs.', USD: '$', ARS: '$', BRL: 'R$' };
        const simbolo = simbolos[divisa] || divisa;
        return `${simbolo} ${Math.round(valor).toLocaleString('es-PY')}`;
    },

    // Convertir entre divisas
    convertirDivisa: async (monto, desde = 'PYG', hacia = 'PYG') => {
        if (desde === hacia) return monto;
        try {
            const tasas = await ConfigService.obtenerTasasCambio();
            if (!tasas[desde] || !tasas[hacia]) {
                console.error('Divisa no configurada:', desde, hacia);
                return monto;
            }
            return (monto / tasas[desde]) * tasas[hacia];
        } catch (e) {
            console.error('Error en conversión de divisa:', e);
            return monto;
        }
    },

    // Toast (notificación)
    mostrarToast: (mensaje, tipo = 'success', duracion = 3000) => {
        const toast = document.getElementById('toast');
        if (!toast) return;

        const iconos = {
            success: 'fa-check-circle text-green-400',
            error: 'fa-exclamation-circle text-red-400',
            warning: 'fa-warning text-yellow-400',
            info: 'fa-info-circle text-blue-400'
        };

        const colores = {
            success: 'bg-green-900 border-green-700',
            error: 'bg-red-900 border-red-700',
            warning: 'bg-yellow-900 border-yellow-700',
            info: 'bg-blue-900 border-blue-700'
        };

        document.getElementById('toast-icon').className = `fa-solid ${iconos[tipo]}`;
        document.getElementById('toast-message').textContent = mensaje;
        toast.className = `fixed top-5 right-5 transform transition-transform duration-300 z-[300] flex items-center p-4 mb-4 text-white rounded-lg shadow-xl border ${colores[tipo]}`;
        
        toast.style.transform = 'translateX(0)';
        setTimeout(() => {
            toast.style.transform = 'translateX(500px)';
        }, duracion);
    },

    // Validar email
    validarEmail: (email) => {
        const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return regex.test(email);
    },

    // Validar teléfono (Paraguay)
    validarTelefono: (telefono) => {
        const regex = /^(\+595|0)[9][0-9]{8}$/;
        return regex.test(telefono.replace(/\s/g, ''));
    },

    // Generar ID único
    generarId: () => {
        return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    },

    // Formatear fecha
    formatoFecha: (fecha) => {
        if (typeof fecha === 'number') fecha = new Date(fecha);
        return fecha.toLocaleDateString('es-PY', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    // Formatear solo hora
    formatoHora: (fecha) => {
        if (typeof fecha === 'number') fecha = new Date(fecha);
        return fecha.toLocaleTimeString('es-PY', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    },

    // Copiar al portapapeles
    copiarAlPortapapeles: async (texto) => {
        try {
            await navigator.clipboard.writeText(texto);
            Utils.mostrarToast('Copiado al portapapeles', 'success', 2000);
        } catch (e) {
            console.error('Error al copiar:', e);
        }
    },

    // Descargar archivo
    descargarArchivo: (datos, nombre, tipo = 'application/json') => {
        const contenido = typeof datos === 'string' ? datos : JSON.stringify(datos, null, 2);
        const blob = new Blob([contenido], { type: tipo });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        a.click();
        URL.revokeObjectURL(url);
    },

    // Esperar (promise delay)
    esperar: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    // Debounce
    debounce: (func, espera) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), espera);
        };
    },

    // Throttle
    throttle: (func, limite) => {
        let enEspera = false;
        return (...args) => {
            if (!enEspera) {
                func(...args);
                enEspera = true;
                setTimeout(() => enEspera = false, limite);
            }
        };
    }
};

// Exportar para Node.js (si aplica)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
