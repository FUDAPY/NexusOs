/**
 * SERVICIO DE PAGOS
 * Maneja métodos de pago, divisas, cambio y división de cuentas
 */

const PaymentService = {
    // Calcular cambio en guaraníes desde cualquier divisa
    calcularCambio: async function(montoEntregar, montoCobrado, divisaEntrega = 'PYG') {
        try {
            // Convertir monto entregado a guaraníes si es necesario
            const montosEnGuaranies = await Utils.convertirDivisa(
                montoEntregar,
                divisaEntrega,
                'PYG'
            );

            const cambio = montosEnGuaranies - montoCobrado;
            return cambio > 0 ? cambio : 0;
        } catch (e) {
            Logger.error('Error calcular cambio:', e);
            return 0;
        }
    },

    // Dividir cuenta entre múltiples pagadores
    dividirCuenta: async function(montoCuenta, pagadores) {
        /**
         * pagadores = [
         *   { montoAPagar: 170000, divisaPago: 'PYG', metodoPago: 'efectivo' },
         *   { montoAPagar: 140000, divisaPago: 'PYG', metodoPago: 'tarjeta' }
         * ]
         */

        try {
            let totalPagado = 0;
            const detallesPago = [];

            for (let pago of pagadores) {
                // Convertir a guaraníes si es otra divisa
                const montoEnGuaranies = await Utils.convertirDivisa(
                    pago.montoAPagar,
                    pago.divisaPago,
                    'PYG'
                );

                detallesPago.push({
                    monto: montoEnGuaranies,
                    divisaOriginal: pago.divisaPago,
                    montoOriginal: pago.montoAPagar,
                    metodoPago: pago.metodoPago || 'efectivo',
                    cambio: await this.calcularCambio(
                        pago.montoAPagar,
                        Math.min(montoEnGuaranies, montoCuenta - totalPagado),
                        pago.divisaPago
                    )
                });

                totalPagado += montoEnGuaranies;
            }

            // Validar que se pagó el total
            if (totalPagado < montoCuenta) {
                throw new Error(`Monto insuficiente. Total: ${totalPagado}, Requerido: ${montoCuenta}`);
            }

            return {
                exitoso: true,
                totalCuenta: montoCuenta,
                totalPagado,
                pagos: detallesPago,
                diferencia: totalPagado - montoCuenta
            };
        } catch (e) {
            Logger.error('Error dividir cuenta:', e);
            Utils.mostrarToast('Error al dividir cuenta', 'error');
            return { exitoso: false, error: e.message };
        }
    },

    // Registrar pago de venta
    registrarPago: async function(ventaData) {
        try {
            const pagoDatos = {
                ventaId: ventaData.ventaId,
                montoCobrado: ventaData.montoCobrado,
                metodoPago: ventaData.metodoPago, // efectivo, tarjeta, transferencia
                divisas: ventaData.divisas || [],
                cambio: ventaData.cambio || 0,
                timestamp: new Date().getTime(),
                usuario: auth.currentUser?.uid,
                sucursal: ventaData.sucursalId
            };

            const docRef = await db.collection('pagos').add(pagoDatos);
            Logger.info('Pago registrado:', pagoDatos);
            return docRef.id;
        } catch (e) {
            Logger.error('Error registrar pago:', e);
            throw e;
        }
    }
};
