import { Router } from 'express';
import {
  cancel,
  create,
  list,
  marcarAbonado,
  resolverCobroHandler,
  updateKdsState,
} from '../controllers/order.controller.js';
import { actualizarCuenta, cerrarCuenta } from '../controllers/cuentaCierre.controller.js';
import { asyncHandler } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';

export const orderRouter: Router = Router();

// Todo /orders exige sesion (ver el control de acceso en app.ts).
orderRouter.use(requiereAuth);

orderRouter.post('/', asyncHandler(create));
orderRouter.get('/', asyncHandler(list));
orderRouter.patch('/:id/cocina', asyncHandler(updateKdsState));

/**
 * Anula una orden devolviendo el stock.
 * Body: { motivo, tipo: 'total'|'parcial', cantidades?: { productoId: n } }
 */
orderRouter.post('/:id/anular', asyncHandler(cancel));

/**
 * Resuelve el cobro de un abono de deuda.
 * Body: { accion: 'aprobar'|'rechazar', autorizadoPor?, autorizadoPorNombre? }
 *
 * Mueve la deuda del cliente, asi que se limita a quien puede autorizar plata:
 * admin, supervisor o cajero.
 */
orderRouter.post(
  '/:id/cobro',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(resolverCobroHandler),
);

/**
 * Cierra (cobra) una cuenta pendiente: la mesa que quedo abierta.
 * Pasa la orden a pagada en vez de crear otra.
 *
 * Mismo conjunto de roles que /cobro y /abonar: cobra quien maneja plata.
 */
orderRouter.post(
  '/:id/cerrar-cuenta',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(cerrarCuenta),
);

import { pagarDeuda, registrarAbono } from '../controllers/pagoDeuda.controller.js';

/**
 * Pago de la deuda de un cliente. Resta la deuda, crea el ticket del abono y otorga
 * los puntos por el monto pagado.
 *
 * Body: { clienteId, monto, metodoPago?, turnoId? }
 */
orderRouter.post(
  '/pagar-deuda',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(pagarDeuda),
);

/**
 * Cobro de deuda registrado por un COBRADOR, pendiente de aprobacion.
 *
 * Body: { clienteId, monto, metodoPago?, observacion? }
 *
 * NO aplica la deuda ni otorga puntos: eso pasa al aprobarse. Si restara la deuda, bastaria
 * con que un cobrador registre un cobro para perdonarla sin respaldo.
 */
orderRouter.post(
  '/abono-pendiente',
  requiereRol('admin', 'supervisor', 'cobrador'),
  asyncHandler(registrarAbono),
);

/* NOTA: aprobar y rechazar un cobro pendiente viven en UN SOLO lugar:
     POST /orders/:id/cobro  { accion: 'aprobar' | 'rechazar' }   (ver mas arriba)
   Aca habia dos rutas equivalentes (/aprobar-abono y /rechazar-abono) y se quitaron: tener
   dos caminos para aplicar la misma plata es como se termina cobrando dos veces.
   El codigo de esas dos quedo sin rutas en pagoDeuda.service.ts, marcado como NO USADO. */

/**
 * Guarda una cuenta abierta (mesa) SIN cobrarla: el "enviar a cocina" del salon.
 * Body: { items, observacion?, estadoCocina?, discountAmount? }
 *
 * Los items REEMPLAZAN a los de la cuenta, no se suman. No mueve stock ni el saldo
 * del cliente: eso pasa al cobrar.
 */
orderRouter.patch(
  '/:id/cuenta-pendiente',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(actualizarCuenta),
);

/**
 * Excluye un ticket del flujo de caja sin anularlo.
 * Body: { motivo, autorizadoPor?, autorizadoPorNombre? }
 */
orderRouter.post(
  '/:id/abonar',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(marcarAbonado),
);
