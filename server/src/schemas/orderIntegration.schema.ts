import { z } from 'zod';

/* Payload del pedido que manda la web publica del restaurante (San Benito).

   Por que existe aparte de `createOrderInputSchema`: `POST /orders` exige el JWT
   de un usuario del POS, y quien pide aca es un cliente desde el navegador, sin
   sesion. Entra por el router de integraciones con `x-service-token`, el mismo
   canal que ya usa OrbitaOs.

   Decision que importa: el PRECIO no viaja. `items[].precio` de
   `createOrderInputSchema` lo resuelve el catalogo (`Product`) en el servidor; si
   se aceptara desde el cliente, cualquiera podria mandar precio 0 desde la
   consola del navegador y la caja cobraria eso. */

export const webOrderItemInputSchema = z.object({
  nombre: z.string().trim().min(1, 'El item necesita nombre').max(180),
  cantidad: z.number().int().min(1).max(99),
  obsProd: z.string().trim().max(300).default(''),
});

export const createWebOrderInputSchema = z.object({
  /* Opcional: si no viene, se toma la unica sucursal configurada. Evita que la
     web tenga que saber el nombre exacto de la sucursal. */
  sucursal: z.string().trim().min(1).max(140).optional(),

  cliente: z.string().trim().max(140).default(''),
  telefono: z.string().trim().max(40).default(''),

  modalidad: z.enum(['local', 'retiro', 'delivery']).default('local'),
  direccionEntrega: z.string().trim().max(220).default(''),

  observacion: z.string().trim().max(400).default(''),

  items: z
    .array(webOrderItemInputSchema)
    .min(1, 'El pedido necesita al menos un item')
    .max(50, 'Demasiados items en un pedido'),
});

export type CreateWebOrderInput = z.infer<typeof createWebOrderInputSchema>;
export type WebOrderItemInput = z.infer<typeof webOrderItemInputSchema>;
