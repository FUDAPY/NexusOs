import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Item de ticket. Firestore: sales[].items -> embebido en orders + coleccion order_items.
 * Los campos originales se conservan con el mismo nombre; los derivados los agrega el ETL.
 */
export interface IOrderItem {
  // --- originales de Firestore (sales[].items) ---
  id: string;
  uniqueId: number;
  nombre: string;
  precio: number;
  categoria: string;
  cantidad: number;
  controlado: boolean;
  descuento: number;
  descuentoVip: number;
  descuentoBogo: number;
  promocionBogo: boolean;
  codigo: string;
  icono: string;
  obsProd: string;

  // --- derivados por el ETL (solo en la coleccion order_items) ---
  orderId?: Types.ObjectId | null;
  productoId?: string;
  subtotal?: number;
  ticket_id?: string;
  sucursal?: string;
  fecha?: Date | null;
}

export type OrderItemDocument = HydratedDocument<IOrderItem>;

// Definicion sin anotacion de generico: reutilizable en el subdocumento y en la coleccion raiz.
const orderItemFields = {
  id: { type: String, default: '' },
  uniqueId: { type: Number, default: 0 },
  nombre: { type: String, required: true, trim: true, maxlength: 180 },
  precio: { type: Number, required: true, min: 0 },
  categoria: { type: String, default: 'Sin Categoria', trim: true },
  cantidad: { type: Number, required: true, min: 1 },
  controlado: { type: Boolean, default: false },
  descuento: { type: Number, default: 0, min: 0 },
  descuentoVip: { type: Number, default: 0, min: 0 },
  descuentoBogo: { type: Number, default: 0, min: 0 },
  promocionBogo: { type: Boolean, default: false },
  codigo: { type: String, default: '' },
  icono: { type: String, default: 'fa-box' },
  obsProd: { type: String, default: '', maxlength: 300 },
};

export const orderItemSchema = new Schema<IOrderItem>(orderItemFields, {
  _id: false,
  versionKey: false,
});

const orderItemDocSchema = new Schema<IOrderItem, Model<IOrderItem>>(
  {
    ...orderItemFields,
    // Campos derivados: presentes solo en la coleccion order_items.
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    productoId: { type: String, default: '' },
    subtotal: { type: Number, default: 0, min: 0 },
    ticket_id: { type: String, default: '' },
    sucursal: { type: String, default: 'Unificado' },
    fecha: { type: Date, default: null },
  },
  {
    versionKey: false,
    collection: 'order_items',
    strict: true,
  },
);

orderItemDocSchema.index({ orderId: 1 });
orderItemDocSchema.index({ ticket_id: 1 });
orderItemDocSchema.index({ productoId: 1, fecha: -1 });
orderItemDocSchema.index({ sucursal: 1, fecha: -1 });
orderItemDocSchema.index({ nombre: 'text' });

export const OrderItem = model<IOrderItem, Model<IOrderItem>>('OrderItem', orderItemDocSchema);
