import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export const PRODUCT_ESTADOS = ['Activo', 'Inactivo'] as const;
export type ProductEstado = (typeof PRODUCT_ESTADOS)[number];

export const PRODUCT_VISIBILIDAD = ['Unificado', 'Sucursal'] as const;
export type ProductVisibilidad = (typeof PRODUCT_VISIBILIDAD)[number];

export interface IProduct {
  codigo?: string;
  nombre: string;
  precio: number;
  precioCosto: number;
  categoria: string;
  categoriaId?: Types.ObjectId | null;
  icono: string;
  imagen?: string;
  imagenes: string[];
  estado: ProductEstado;
  
  sucursal: string;
  sucursalNombre: string;
  sucursalId?: Types.ObjectId | null;
  visibilidad: ProductVisibilidad;

  
  controlado: boolean;
  stock: number;
  stockMinimo: number;
  agotado: boolean;

  descuento: number;
  promocionBogo: boolean;
  permiteProductoGratis: boolean;

  usaProduccionCarne: boolean;
  medallonesPorUnidad: number;
  usaProduccionPan: boolean;
  panesPorUnidad: number;
  usaProduccionPapa: boolean;
  papasPorUnidad: number;
  usaProduccionCarneSalteado: boolean;
  carneSalteadoPorUnidad: number;
  usaProduccionCarneLomito: boolean;
  carneLomitoPorUnidad: number;
  usaProduccionPanLomito: boolean;
  panLomitoPorUnidad: number;

  puntosCanje: number;
  creadoEn: Date;
  actualizadoEn: Date;
}

export type ProductDocument = HydratedDocument<IProduct>;

const nonNegativeInt = { type: Number, default: 0, min: 0 };

/* ===========================================================================
   `agotado` es un campo DERIVADO: `controlado === true && stock <= 0`.

   Antes solo lo definia `pre('save')`, y hay cuatro maneras de escribir un
   producto SIN pasar por `save()`:
     - PATCH /products/:id   -> resource.factory.ts   ($set)
     - ajuste de inventario  -> inventario.service    ($set)
     - cierre de produccion  -> orderCierre.service   ($set)
     - venta en el POS       -> order.service         ($inc)
   Las cuatro dejaban `agotado` desactualizado. La mas visible: reponer stock
   desde el formulario de inventario no lo volvia a poner en `false`, y OrbitaOs
   seguia recibiendo `agotado: true` en `GET /integrations/stock` de un producto
   que ya tenia mercaderia. Los hooks de abajo rederivan dentro de la MISMA
   escritura, asi que no hay ventana en la que el flag mienta.

   El caso `$inc` (la venta) no se toca aca: `order.service.ts` le pone encima un
   `updateOne` con pipeline que ya deriva de forma atomica, y este hook se salta
   los pipelines a proposito.
   =========================================================================== */

/** Lo minimo que hay que saber del documento para poder derivar `agotado`. */
export interface ProductoStockActual {
  controlado?: unknown;
  stock?: unknown;
}

/** Una escritura de Mongoose: operadores (`$set`, `$inc`, ...) o pipeline. */
export type EscrituraProducto = Record<string, unknown> | unknown[];

/**
 * `findOne().lean()` viene tipado como cualquier cosa desde `Model<any>` y hasta
 * puede resolver en array. Se normaliza ahi, antes de tocar la derivacion: lo que
 * no sea un objeto simple se trata como "no hay documento" (`null`).
 */
export const comoDocumentoStock = (valor: unknown): ProductoStockActual | null =>
  valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as ProductoStockActual)
    : null;

/** Unica regla de negocio de `agotado`. La comparten `pre('save')` y los hooks de update. */
export const calcularAgotado = (controlado: unknown, stock: unknown): boolean =>
  controlado === true && Number(stock ?? 0) <= 0;

const aBooleano = (valor: unknown): boolean | undefined => {
  if (valor === true || valor === false) return valor;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  return undefined;
};

/* Los hooks corren ANTES del casteo de Mongoose, así que un PATCH puede traer
   `'5'` o `true` como string. Si el valor no es interpretable no se deriva:
   prefiero dejar `agotado` como estaba (comportamiento anterior) a escribir
   una derivacion sobre datos que todavia no son los definitivos. */
const aNumero = (valor: unknown): number | undefined => {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : undefined;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : undefined;
  }
  return undefined;
};

const leerSet = (escritura: Record<string, unknown>): Record<string, unknown> | null => {
  const candidato = escritura['$set'];
  if (candidato === null || typeof candidato !== 'object' || Array.isArray(candidato)) return null;
  return candidato as Record<string, unknown>;
};

/**
 * `true` cuando la escritura puede cambiar `agotado` pero le falta alguno de los
 * dos datos: hay que leer el documento antes de poder derivarlo.
 */
export const requiereLecturaParaAgotado = (escritura: EscrituraProducto): boolean => {
  if (Array.isArray(escritura)) return false;
  const set = leerSet(escritura);
  if (set === null) return false;
  if (set['stock'] === undefined && set['controlado'] === undefined) return false;
  return set['stock'] === undefined || set['controlado'] === undefined;
};

/**
 * Devuelve la escritura con `agotado` ya derivado, o `null` si no hay que tocar
 * nada (pipeline, escritura que no toca stock/controlado, o dato ilegible).
 *
 * `actual` es `undefined` cuando no hizo falta leer, y `null` cuando se intento
 * leer y no habia documento: ahi la escritura no afecta a nadie y no se deriva.
 */
export const aplicarAgotado = (
  escritura: EscrituraProducto,
  actual: ProductoStockActual | null | undefined,
): EscrituraProducto | null => {
  if (Array.isArray(escritura)) return null;
  const set = leerSet(escritura);
  if (set === null) return null;

  const cambiaStock = set['stock'] !== undefined;
  const cambiaControlado = set['controlado'] !== undefined;
  if (!cambiaStock && !cambiaControlado) return null;

  const hayDocumento = actual !== undefined && actual !== null;
  let stock: number | undefined;
  let controlado: boolean | undefined;

  if (cambiaStock) stock = aNumero(set['stock']);
  else if (hayDocumento && actual !== null && actual !== undefined) stock = aNumero(actual.stock) ?? 0;

  if (cambiaControlado) controlado = aBooleano(set['controlado']);
  else if (hayDocumento && actual !== null && actual !== undefined) controlado = actual.controlado === true;

  if (stock === undefined || controlado === undefined) return null;

  return { ...escritura, $set: { ...set, agotado: calcularAgotado(controlado, stock) } };
};

const productSchema = new Schema<IProduct, Model<IProduct>>(
  {
    codigo: { type: String, trim: true },
    nombre: { type: String, required: true, trim: true, maxlength: 160 },
    precio: { type: Number, required: true, min: 0 },
    precioCosto: { type: Number, default: 0, min: 0 },
    categoria: { type: String, default: 'Sin Categoria', trim: true, index: true },
    categoriaId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    icono: { type: String, default: 'fa-box' },
    imagen: { type: String, default: '' },
    imagenes: { type: [String], default: [] },
    estado: { type: String, enum: PRODUCT_ESTADOS, default: 'Activo', index: true },

    sucursal: { type: String, default: 'Unificado', trim: true, index: true },
    sucursalNombre: { type: String, default: 'Unificado', trim: true },
    sucursalId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    visibilidad: { type: String, enum: PRODUCT_VISIBILIDAD, default: 'Unificado' },

    controlado: { type: Boolean, default: false },
    stock: nonNegativeInt,
    stockMinimo: nonNegativeInt,
    agotado: { type: Boolean, default: false, index: true },

    descuento: { type: Number, default: 0, min: 0, max: 100 },
    promocionBogo: { type: Boolean, default: false },
    permiteProductoGratis: { type: Boolean, default: false },

    usaProduccionCarne: { type: Boolean, default: false },
    medallonesPorUnidad: nonNegativeInt,
    usaProduccionPan: { type: Boolean, default: false },
    panesPorUnidad: nonNegativeInt,
    usaProduccionPapa: { type: Boolean, default: false },
    papasPorUnidad: nonNegativeInt,
    usaProduccionCarneSalteado: { type: Boolean, default: false },
    carneSalteadoPorUnidad: nonNegativeInt,
    usaProduccionCarneLomito: { type: Boolean, default: false },
    carneLomitoPorUnidad: nonNegativeInt,
    usaProduccionPanLomito: { type: Boolean, default: false },
    panLomitoPorUnidad: nonNegativeInt,

    puntosCanje: nonNegativeInt,
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'products',
  },
);

/* Regla derivada, no escrita a mano: ver el bloque de cabecera de este archivo. */
productSchema.pre('save', function syncAgotado(next) {
  this.agotado = calcularAgotado(this.controlado, this.stock);
  next();
});

/* Rederivacion para las escrituras que NO pasan por save(). Ver el bloque de
   cabecera: sin esto, reponer stock desde el formulario de inventario dejaba el
   producto con agotado=true y OrbitaOs seguia recibiendo "sin mercaderia" en
   GET /integrations/stock. Se lee el documento solo cuando el update trae stock
   o controlado pero no los dos (el caso comun: $set con stock y nada mas).

   El caso $inc de la venta (order.service) no se deriva ahi: ese mismo archivo
   le pone encima un updateOne en pipeline que ya calcula agotado de forma
   atomica, y este hook se salta los pipelines a proposito. */
productSchema.pre('findOneAndUpdate', async function syncAgotadoUpdate() {
  const escritura = this.getUpdate();
  if (escritura === null) return;
  const cruda = escritura as EscrituraProducto;
  const actual = requiereLecturaParaAgotado(cruda)
    ? comoDocumentoStock(await this.model.findOne(this.getFilter()).select('stock controlado').lean().exec())
    : undefined;
  const ajustada = aplicarAgotado(cruda, actual);
  if (ajustada !== null) this.setUpdate(ajustada as unknown as NonNullable<typeof escritura>);
});

productSchema.pre('updateOne', async function syncAgotadoUpdateOne() {
  const escritura = this.getUpdate();
  if (escritura === null) return;
  const cruda = escritura as EscrituraProducto;
  const actual = requiereLecturaParaAgotado(cruda)
    ? comoDocumentoStock(await this.model.findOne(this.getFilter()).select('stock controlado').lean().exec())
    : undefined;
  const ajustada = aplicarAgotado(cruda, actual);
  if (ajustada !== null) this.setUpdate(ajustada as unknown as NonNullable<typeof escritura>);
});

productSchema.index({ sucursalId: 1, estado: 1, categoria: 1 });
productSchema.index({ sucursal: 1, estado: 1, categoria: 1 });
productSchema.index({ estado: 1, agotado: 1, actualizadoEn: -1 });
productSchema.index({ nombre: 'text', codigo: 'text' });

/* `codigo` es la clave con la que OrbitaOs identifica un producto, pero hasta hoy
   NUNCA fue unico: dos productos podian repetirlo y el ajuste de stock caia sobre
   uno cualquiera. Por eso el encargo manda `producto` (nombre) y no `codigo`.

   Es un indice PARCIAL y no `sparse`: inventario.html manda `codigo: null` cuando
   se vacia el campo, y en Mongo un indice unico comun si indexa los `null`, con
   lo que TODOS los productos sin codigo chocarian entre si. El filtro deja entrar
   solo codigos de verdad (string y no vacio).

   En produccion `autoIndex` esta apagado, asi que esto NO se crea solo: hay que
   correr `npm run mongo:indices` (ver deploy/DOKPLOY.md) y ANTES confirmar con
   `npm run productos:duplicados` que no haya codigos repetidos, porque si los hay
   el indice no se crea. El choque responde 409 DUPLICATE_KEY (errorHandler.ts). */
productSchema.index(
  { codigo: 1 },
  {
    name: 'codigo_unico',
    unique: true,
    partialFilterExpression: { codigo: { $type: 'string', $gt: '' } },
  },
);

export const Product = model<IProduct, Model<IProduct>>('Product', productSchema);
