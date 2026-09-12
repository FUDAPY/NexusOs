(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CierreCajaNormalizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const SUCURSALES_AUDITADAS = Object.freeze({
        cafeteria_chicolin: 'Cafetería Chicolín',
        mr_lin_restaurante: 'San Benito Cafe Resto Bar'
    });

    function textoNormalizado(valor) {
        return String(valor ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    }

    function montoANumero(valor) {
        if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
        if (typeof valor === 'bigint') return Number(valor);
        if (valor === null || valor === undefined || valor === '') return 0;

        const original = String(valor).trim();
        const negativo = original.includes('-') || /^\(.*\)$/.test(original);
        let limpio = original.replace(/[^0-9.,]/g, '');
        if (!limpio) return 0;

        const puntos = (limpio.match(/\./g) || []).length;
        const comas = (limpio.match(/,/g) || []).length;
        if (puntos && comas) {
            const decimal = limpio.lastIndexOf('.') > limpio.lastIndexOf(',') ? '.' : ',';
            const miles = decimal === '.' ? ',' : '.';
            limpio = limpio.split(miles).join('').replace(decimal, '.');
        } else if (puntos > 1 || comas > 1) {
            limpio = limpio.replace(/[.,]/g, '');
        } else if (puntos === 1 || comas === 1) {
            const separador = puntos === 1 ? '.' : ',';
            const decimales = limpio.length - limpio.lastIndexOf(separador) - 1;
            limpio = decimales === 3 ? limpio.replace(separador, '') : limpio.replace(separador, '.');
        }

        const numero = Number(limpio);
        if (!Number.isFinite(numero)) return 0;
        return negativo ? -Math.abs(numero) : numero;
    }

    function obtenerRuta(objeto, ruta) {
        return String(ruta).split('.').reduce((actual, segmento) => actual?.[segmento], objeto);
    }

    function primerMonto(objeto, rutas, fallback = 0) {
        for (const ruta of rutas) {
            const valor = obtenerRuta(objeto, ruta);
            if (valor !== undefined && valor !== null && valor !== '') return montoANumero(valor);
        }
        return montoANumero(fallback);
    }

    function normalizarSucursal(valor) {
        const texto = textoNormalizado(valor).replace(/[^a-z0-9]+/g, ' ').trim();
        if (texto === 'cafeteria chicolin' || texto === 'cafeteria_chicolin') {
            return { id: 'cafeteria_chicolin', nombre: SUCURSALES_AUDITADAS.cafeteria_chicolin };
        }
        if (texto === 'mr lin restaurante' || texto === 'mr_lin_restaurante') {
            return { id: 'mr_lin_restaurante', nombre: SUCURSALES_AUDITADAS.mr_lin_restaurante };
        }
        if (texto.includes('cafeteria') && texto.includes('chicolin')) {
            return { id: 'cafeteria_chicolin', nombre: SUCURSALES_AUDITADAS.cafeteria_chicolin };
        }
        if (texto === 'cafeteria chicolin') {
            return { id: 'cafeteria_chicolin', nombre: SUCURSALES_AUDITADAS.cafeteria_chicolin };
        }
        if (texto === 'mr lin restaurante') {
            return { id: 'mr_lin_restaurante', nombre: SUCURSALES_AUDITADAS.mr_lin_restaurante };
        }
        if (texto.includes('san') && texto.includes('benito')) {
            return { id: 'mr_lin_restaurante', nombre: SUCURSALES_AUDITADAS.mr_lin_restaurante };
        }
        if ((texto.includes('mr') || texto.includes('mister')) && texto.includes('lin')) {
            return { id: 'mr_lin_restaurante', nombre: SUCURSALES_AUDITADAS.mr_lin_restaurante };
        }
        return { id: '', nombre: String(valor || '').trim() };
    }

    function esSucursalAuditada(valor) {
        return Boolean(normalizarSucursal(valor).id);
    }

    function obtenerSucursalesAuditadas() {
        return Object.entries(SUCURSALES_AUDITADAS).map(([id, nombre]) => ({ id, nombre }));
    }

    function obtenerSucursalRegistro(registro = {}) {
        const idDirecto = normalizarSucursal(
            registro.sucursalId ||
            registro.branchId ||
            registro.sucursalKey ||
            registro.branchKey ||
            registro.localId ||
            ''
        );
        if (idDirecto.id) return idDirecto;
        return normalizarSucursal(
            registro.sucursal ||
            registro.sucursalNombre ||
            registro.nombreSucursal ||
            registro.branchName ||
            registro.branch ||
            registro.local ||
            ''
        );
    }

    function coincideSucursalRegistro(registro = {}, filtro = '') {
        const filtroNormalizado = normalizarSucursal(filtro);
        if (!filtroNormalizado.id) return true;
        return obtenerSucursalRegistro(registro).id === filtroNormalizado.id;
    }

    function fechaAFecha(valor) {
        if (!valor) return null;
        if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
        if (typeof valor.toDate === 'function') return fechaAFecha(valor.toDate());
        if (typeof valor.seconds === 'number') return new Date(valor.seconds * 1000);
        const fecha = new Date(valor);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    function fechaKey(valor) {
        if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
        const fecha = fechaAFecha(valor);
        if (!fecha) return '';
        return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
    }

    function fechaIso(valor) {
        const fecha = fechaAFecha(valor);
        return fecha ? fecha.toISOString() : '';
    }

    function normalizarCierreCaja(cierre = {}, cierreId = '') {
        const sucursalInfo = normalizarSucursal(cierre.sucursal || cierre.branchName || cierre.branch || cierre.sucursalNombre);
        if (!sucursalInfo.id) return null;

        const fondoInicial = primerMonto(cierre, ['fondoInicial', 'fondo', 'apertura.fondoInicial']);
        const gastos = primerMonto(cierre, ['declaracion.gastos', 'gastos', 'gastosDeclarado', 'gastosDeclarados', 'totalGastos']);
        const efectivoPos = primerMonto(cierre, ['resumenFinanciero.efectivoPos', 'sistema.ventasEfectivo', 'ventasEfectivo', 'efectivoPos', 'totalEfectivo', 'pagosEfectivo']);
        const efectivoDeclarado = primerMonto(cierre, ['resumenFinanciero.efectivoDeclarado', 'declaracion.efectivo', 'efectivoDeclarado', 'efectivoCaja', 'efectivo']);
        const efectivoEsperado = primerMonto(
            cierre,
            ['resumenFinanciero.efectivoEsperado', 'sistema.totalEsperadoEfectivo', 'efectivoEsperado', 'totalEsperadoEfectivo'],
            efectivoPos + fondoInicial - gastos
        );
        const posTarjeta = primerMonto(cierre, ['resumenFinanciero.posTarjeta', 'sistema.ventasTarjeta', 'ventasTarjeta', 'posTarjeta', 'totalPos', 'totalTarjeta', 'pagosTarjeta', 'tarjeta']);
        const transferencia = primerMonto(cierre, ['resumenFinanciero.transferencia', 'sistema.ventasTransferencia', 'ventasTransferencia', 'transferencias', 'transferencia', 'totalTransferencia']);
        const credito = primerMonto(cierre, ['resumenFinanciero.credito', 'sistema.ventasCredito', 'ventasCredito', 'totalCredito', 'creditos', 'credito', 'creditoCalculadoDesdeVentas']);
        const posTarjetaDeclarado = primerMonto(cierre, ['declaracion.tarjeta', 'tarjetaDeclarada', 'posDeclarado', 'totalPosDeclarado'], posTarjeta);
        const transferenciaDeclarada = primerMonto(cierre, ['declaracion.transferencia', 'transferenciaDeclarada', 'totalTransferenciaDeclarada'], transferencia);
        const totalVentas = primerMonto(cierre, ['sistema.totalVentas'], efectivoPos + posTarjeta + transferencia);

        // La única convención financiera válida es declarado menos esperado.
        const diferenciaCaja = efectivoDeclarado - efectivoEsperado;
        const diferenciaPosTarjeta = posTarjetaDeclarado - posTarjeta;
        const diferenciaTransferencia = transferenciaDeclarada - transferencia;
        const totalEsperado = efectivoEsperado + posTarjeta + transferencia;
        const totalDeclarado = efectivoDeclarado + posTarjetaDeclarado + transferenciaDeclarada;
        const diferenciaTotal = totalDeclarado - totalEsperado;
        const sobrante = diferenciaCaja > 0 ? diferenciaCaja : 0;
        const faltante = diferenciaCaja < 0 ? Math.abs(diferenciaCaja) : 0;
        const fecha = cierre.fechaOperacionKey || cierre.fechaCierreKey || fechaKey(cierre.fechaCierre || cierre.creadoEn || cierre.fecha);

        return {
            sucursal: sucursalInfo.nombre,
            sucursalId: sucursalInfo.id,
            fecha,
            efectivoPos,
            efectivoDeclarado,
            efectivoEsperado,
            posTarjeta,
            posTarjetaDeclarado,
            transferencia,
            transferenciaDeclarada,
            credito,
            gastos,
            totalVentas,
            totalEsperado,
            totalDeclarado,
            diferenciaCaja,
            diferenciaPosTarjeta,
            diferenciaTransferencia,
            diferenciaTotal,
            sobrante,
            faltante,
            origen: 'Sistema POS',
            cierreId: String(cierreId || cierre.id || ''),
            turnoId: String(cierre.turnoId || ''),
            creadoEn: fechaIso(cierre.creadoEn || cierre.fechaCierre),
            actualizadoEn: fechaIso(cierre.corregidoAt || cierre.actualizadoEn || cierre.updatedAt),
            cierreForzado: cierre.cierreForzado === true,
            correccionAdmin: cierre.correccionAdmin === true,
            ticketsContados: montoANumero(cierre.ticketsContados || cierre.ticketsTurnoIds?.length || cierre.ticketsIds?.length || 0)
        };
    }

    function deduplicarCierres(cierres = []) {
        const unicos = new Map();
        cierres.forEach((cierre, indice) => {
            const normalizado = normalizarCierreCaja(cierre, cierre.id);
            if (!normalizado) return;
            const clave = normalizado.turnoId
                ? `${normalizado.sucursalId}::turno::${normalizado.turnoId}`
                : `${normalizado.sucursalId}::cierre::${normalizado.cierreId || indice}`;
            const anterior = unicos.get(clave);
            const marcaActual = Date.parse(normalizado.actualizadoEn || normalizado.creadoEn || '') || 0;
            const marcaAnterior = Date.parse(anterior?.actualizadoEn || anterior?.creadoEn || '') || 0;
            if (!anterior || marcaActual >= marcaAnterior) unicos.set(clave, normalizado);
        });
        return Array.from(unicos.values());
    }

    function agregarCierres(cierres = []) {
        return cierres.reduce((total, cierre) => {
            const normalizado = cierre?.origen === 'Sistema POS' ? cierre : normalizarCierreCaja(cierre, cierre?.id);
            if (!normalizado) return total;
            total.cierres += 1;
            total.efectivoPos += normalizado.efectivoPos;
            total.efectivoDeclarado += normalizado.efectivoDeclarado;
            total.efectivoEsperado += normalizado.efectivoEsperado;
            total.posTarjeta += normalizado.posTarjeta;
            total.transferencia += normalizado.transferencia;
            total.credito += normalizado.credito;
            total.gastos += normalizado.gastos;
            total.totalVentas += normalizado.totalVentas;
            total.totalEsperado += normalizado.totalEsperado;
            total.totalDeclarado += normalizado.totalDeclarado;
            total.sobrante += normalizado.sobrante;
            total.faltante += normalizado.faltante;
            total.diferenciaCaja += normalizado.diferenciaCaja;
            total.diferenciaTotal += normalizado.diferenciaTotal;
            return total;
        }, {
            cierres: 0,
            efectivoPos: 0,
            efectivoDeclarado: 0,
            efectivoEsperado: 0,
            posTarjeta: 0,
            transferencia: 0,
            credito: 0,
            gastos: 0,
            totalVentas: 0,
            totalEsperado: 0,
            totalDeclarado: 0,
            sobrante: 0,
            faltante: 0,
            diferenciaCaja: 0,
            diferenciaTotal: 0
        });
    }

    function calcularComparativaFinanciera({
        cierres = [],
        efectivoFinanciero = 0,
        gastosFinancieros = 0
    } = {}) {
        const totales = agregarCierres(cierres);
        const efectivoFin = montoANumero(efectivoFinanciero);
        const gastosFin = montoANumero(gastosFinancieros);
        const resultadoPos = totales.efectivoPos + totales.sobrante - totales.faltante - gastosFin;
        const resultadoFinanciero = efectivoFin + totales.sobrante - totales.faltante - totales.posTarjeta - totales.transferencia - gastosFin;
        return {
            ...totales,
            efectivoFinanciero: efectivoFin,
            gastosFinancieros: gastosFin,
            resultadoPos,
            resultadoFinanciero,
            diferenciaSistemas: resultadoFinanciero - resultadoPos
        };
    }

    return Object.freeze({
        SUCURSALES_AUDITADAS,
        montoANumero,
        normalizarSucursal,
        obtenerSucursalesAuditadas,
        obtenerSucursalRegistro,
        coincideSucursalRegistro,
        esSucursalAuditada,
        fechaKey,
        normalizarCierreCaja,
        deduplicarCierres,
        agregarCierres,
        calcularComparativaFinanciera
    });
});
