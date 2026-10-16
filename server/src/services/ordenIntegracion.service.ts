import { Branch, Product } from '../models/index.js';
import { createOrderInputSchema } from '../schemas/order.schema.js';
import type { CreateWebOrderInput } from '../schemas/orderIntegration.schema.js';
import { createOrder, type CreateOrderResult } from './order.service.js';
import { AppError } from '../utils/response.js';

/* Pedidos que entran desde la web publica del restaurante (San Benito).

   La web NO habla con Mongo: entra por `POST /integrations/orders`, que exige
   `x-service-token`, y de aca sale una orden normal del POS. Se gana lo que un
   insert directo en la base no puede dar:

   1. Transaccion ACID: el stock de los productos controlados se descuenta con
      lock, asi que dos pedidos web simultaneos no venden de mas.
   2. `createOrder` emite `venta:creada` por Socket.IO: el pedido aparece solo en
      la caja y en el KDS, sin que nadie apriete nada.
   3. Auditoria: queda registrado como cualquier venta.

   El precio NO se acepta desde el navegador: se resuelve contra el catalogo. */

/** Autor que queda registrado en la orden: no es un empleado, es la web. */
export const CAJERO_WEB = 'Web San Benito';

/** Marca de origen que viaja en `observacion`, para que la caja vea de donde salio. */
export const ORIGEN_WEB = 'web-sanbenito';

const LIMITE_OBSERVACION = 400;

/** Quita tildes y unifica mayusculas/espacios: para comparar como escribe la gente. */
export const normalizarTexto = (valor: string | null | undefined): string =>
  String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lo minimo que se necesita de un producto para armar el item. */
export interface ProductoCatalogo {
  _id: unknown;
  nombre: string;
  codigo?: string | null;
  categoria?: string | null;
  precio?: number | null;
  icono?: string | null;
  controlado?: boolean | null;
  agotado?: boolean | null;
}

/**
 * Traduce un producto del catalogo al item del ticket.
 *
 * El precio sale de aca, del producto en la base, nunca del navegador: si se
 * aceptara desde el cliente, cualquiera podria mandar precio 0 desde la consola.
 * Los descuentos arrancan en 0 porque los aplica la caja, no la web.
 */
export const itemDeCatalogo = (
  producto: ProductoCatalogo,
  cantidad: number,
  obsProd: string,
): Record<string, unknown> => ({
  id: String(producto._id),
  nombre: producto.nombre,
  categoria: (producto.categoria ?? '').trim() || 'Sin Categoria',
  cantidad,
  precio: Number(producto.precio ?? 0),
  controlado: producto.controlado === true,
  descuento: 0,
  descuentoVip: 0,
  descuentoBogo: 0,
  promocionBogo: false,
  codigo: producto.codigo ?? '',
  icono: (producto.icono ?? '').trim() || 'fa-box',
  obsProd,
});

/** Arma la observacion que ve la caja: origen, modalidad, telefono, direccion y nota. */
export const componerObservacion = (input: CreateWebOrderInput): string => {
  const partes: string[] = [`${ORIGEN_WEB} · ${input.modalidad}`];

  const cliente = input.cliente.trim();
  if (cliente !== '') partes.push(cliente);
  if (input.telefono !== '') partes.push(`Tel ${input.telefono}`);
  if (input.modalidad === 'delivery' && input.direccionEntrega !== '') {
    partes.push(`Dir ${input.direccionEntrega}`);
  }
  if (input.observacion !== '') partes.push(input.observacion);

  return partes.join(' · ').slice(0, LIMITE_OBSERVACION);
};

export interface SucursalResuelta {
  sucursal: string;
  sucursalId?: string;
}

/**
 * Resuelve la sucursal del pedido.
 *
 * Con una sola sucursal cargada no hace falta que la web la sepa. Con varias NO
 * se adivina: cargar el pedido en la sucursal equivocada no se detecta hasta el
 * conteo de stock, asi que se rechaza y el pedido no entra.
 */
export const resolverSucursal = async (pedida?: string): Promise<SucursalResuelta> => {
  const nombre = (pedida ?? '').trim();

  if (nombre !== '') {
    const encontrada = await Branch.findOne({ nombre }).exec();
    if (encontrada === null) {
      throw new AppError(`La sucursal "${nombre}" no existe`, 422, 'SUCURSAL_INEXISTENTE');
    }
    return { sucursal: encontrada.nombre, sucursalId: String(encontrada._id) };
  }

  const total = await Branch.countDocuments().exec();
  if (total === 0) throw new AppError('No hay sucursales configuradas', 422, 'SIN_SUCURSALES');
  if (total > 1) {
    throw new AppError('Hay mas de una sucursal: hay que indicar cual', 422, 'SUCURSAL_AMBIGUA');
  }

  const unica = await Branch.findOne().exec();
  if (unica === null) throw new AppError('No hay sucursales configuradas', 422, 'SIN_SUCURSALES');
  return { sucursal: unica.nombre, sucursalId: String(unica._id) };
};

/**
 * Busca el producto que quiso pedir el cliente.
 *
 * Prioriza la coincidencia exacta (nombre o codigo). Con varios parecidos
 * devuelve error en vez del primero de la lista: cobrar el plato equivocado es
 * peor que pedirle al cliente que vuelva a elegir.
 */
export const resolverProducto = async (pedido: string): Promise<ProductoCatalogo> => {
  const limpio = pedido.trim();

  const exactos = await Product.find({ $or: [{ nombre: limpio }, { codigo: limpio }] })
    .limit(2)
    .exec();
  const exacto = exactos.length === 1 ? exactos[0] : undefined;
  if (exacto !== undefined) return exacto;

  const candidatos = await Product.find({
    estado: 'Activo',
    nombre: { $regex: escaparRegex(limpio), $options: 'i' },
  })
    .limit(6)
    .exec();

  const buscado = normalizarTexto(limpio);
  const iguales = candidatos.filter(
    (c) => normalizarTexto(c.nombre) === buscado || normalizarTexto(c.codigo) === buscado,
  );

  const elegido =
    iguales.length === 1 ? iguales[0] : candidatos.length === 1 ? candidatos[0] : undefined;
  if (elegido !== undefined) return elegido;

  if (candidatos.length === 0) {
    throw new AppError(`No encontramos "${pedido}" en la carta`, 422, 'PRODUCTO_NO_ENCONTRADO');
  }
  throw new AppError(`"${pedido}" coincide con mas de un plato de la carta`, 422, 'PRODUCTO_AMBIGUO');
};

export interface PedidoWebCreado {
  orderId: string;
  ticketId: string;
  total: number;
  estadoCocina: string;
  estadoPago: string;
}

/**
 * Crea la orden del pedido web dentro del flujo normal del POS.
 *
 * No se inserta nada a mano: se arma el payload, se valida con el MISMO schema
 * que usa el POS y se llama a `createOrder`, para que la orden tenga la misma
 * forma, los mismos defaults, el mismo descuento de stock, la misma auditoria y
 * el mismo aviso por Socket.IO a caja y KDS.
 */
export const crearPedidoWeb = async (
  input: CreateWebOrderInput,
  contexto: { ip: string; userAgent: string },
): Promise<PedidoWebCreado> => {
  const sucursal = await resolverSucursal(input.sucursal);

  const items: Record<string, unknown>[] = [];
  for (const item of input.items) {
    const producto = await resolverProducto(item.nombre);
    if (producto.agotado === true) {
      throw new AppError(`"${producto.nombre}" esta agotado`, 409, 'PRODUCTO_AGOTADO');
    }
    items.push(itemDeCatalogo(producto, item.cantidad, item.obsProd));
  }

  const payload = createOrderInputSchema.safeParse({
    tipoTransaccion: 'venta_comida',
    sucursal: sucursal.sucursal,
    sucursalId: sucursal.sucursalId,
    cajero: CAJERO_WEB,
    cliente: input.cliente !== '' ? input.cliente : 'ocasional',
    nombreCliente: input.cliente !== '' ? input.cliente : 'Pedido web',
    items,
    metodoPago: 'Efectivo',

    /* La web no cobra: el dinero se rinde en caja al entregar. La orden nace
       pendiente de pago, pero ya afecta caja y ya entra al KDS. */
    estadoPago: 'pendiente',
    observacion: componerObservacion(input),
  });

  if (!payload.success) {
    const detalle = payload.error.issues.map((issue) => issue.message).join(' | ');
    throw new AppError(`Pedido invalido: ${detalle}`, 422, 'VALIDATION_ERROR');
  }

  const resultado: CreateOrderResult = await createOrder(payload.data, contexto);

  return {
    orderId: resultado.orderId,
    ticketId: String(resultado.order.ticket_id ?? ''),
    total: Number(resultado.order.total ?? 0),
    estadoCocina: String(resultado.order.estadoCocina ?? 'pendiente'),
    estadoPago: String(resultado.order.estadoPago ?? 'pendiente'),
  };
};
