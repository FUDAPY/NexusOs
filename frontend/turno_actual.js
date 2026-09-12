(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TurnoActual = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalizarTexto(valor) {
        return String(valor ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    }

    function claveSucursal(valor) {
        return normalizarTexto(valor).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    function convertirFecha(valor) {
        if (!valor) return null;
        if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
        if (typeof valor.toDate === 'function') return convertirFecha(valor.toDate());
        if (typeof valor.seconds === 'number') return new Date(valor.seconds * 1000);
        if (typeof valor._seconds === 'number') return new Date(valor._seconds * 1000);
        const fecha = new Date(valor);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    function obtenerFechaCierre(cierre = {}) {
        return convertirFecha(
            cierre.closedAt ||
            cierre.fechaCierre ||
            cierre.createdAt ||
            cierre.creadoEn ||
            cierre.timestamp
        );
    }

    function obtenerFechaTicket(ticket = {}) {
        return convertirFecha(ticket.createdAt || ticket.fecha || ticket.timestamp);
    }

    function cierreEsValido(cierre = {}) {
        const estado = normalizarTexto(cierre.estado || cierre.status);
        return cierre.anulado !== true && cierre.eliminado !== true && !['anulado', 'cancelado', 'rechazado'].includes(estado);
    }

    function crearMapaUltimosCierres(cierres = []) {
        const mapa = new Map();
        cierres.forEach((cierre) => {
            if (!cierreEsValido(cierre)) return;
            const clave = claveSucursal(cierre.sucursal || cierre.branchName || cierre.branch);
            const fecha = obtenerFechaCierre(cierre);
            if (!clave || !fecha) return;
            const actual = mapa.get(clave);
            if (!actual || fecha.getTime() > actual.fecha.getTime()) {
                mapa.set(clave, {
                    fecha,
                    cierreId: String(cierre.id || cierre.cierreId || ''),
                    sucursal: String(cierre.sucursal || cierre.branchName || cierre.branch || '')
                });
            }
        });
        return mapa;
    }

    function obtenerInicioTurno(mapa, sucursal) {
        return mapa instanceof Map ? mapa.get(claveSucursal(sucursal)) || null : null;
    }

    function ticketPerteneceAlTurno(ticket, mapa) {
        if (!ticket || ticket.arqueado === true) return false;
        const fechaTicket = obtenerFechaTicket(ticket);
        if (!fechaTicket) return false;
        const inicio = obtenerInicioTurno(mapa, ticket.sucursal);
        if (!inicio) return true;
        return fechaTicket.getTime() > inicio.fecha.getTime();
    }

    function filtrarTicketsTurno(tickets = [], mapa = new Map()) {
        return tickets.filter(ticket => ticketPerteneceAlTurno(ticket, mapa));
    }

    return Object.freeze({
        claveSucursal,
        convertirFecha,
        obtenerFechaCierre,
        obtenerFechaTicket,
        crearMapaUltimosCierres,
        obtenerInicioTurno,
        ticketPerteneceAlTurno,
        filtrarTicketsTurno
    });
});
