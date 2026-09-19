import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Imagenes subidas por el panel: logo de sucursal, foto de producto, foto de ticket.
 *
 * POR QUE VIVE EN MONGO
 * Las tres pantallas subian a Firebase Storage, que ya no autoriza: subir una imagen NUNCA
 * funcionaba. La alternativa era guardar en disco, pero con el deploy contenerizado el disco
 * es EFIMERO: las imagenes se borrarian en cada despliegue, sin que nadie se entere. En la
 * base sobreviven, que es lo que se espera de un logo.
 *
 * POR QUE UN BUFFER Y NO UN ARCHIVO
 * Son imagenes chicas (logos y fotos de ticket, hasta 4 MB) y entran de sobra en el limite de
 * 16 MB por documento de Mongo. Un bucket de archivos seria otro servicio que administrar.
 */
const uploadSchema = new Schema(
  {
    carpeta: { type: String, default: 'general', trim: true, index: true },
    nombre: { type: String, default: '', trim: true },
    mime: { type: String, required: true, trim: true },
    tamano: { type: Number, default: 0 },
    datos: { type: Buffer, required: true },
    subidoPor: { type: String, default: '' },
  },
  { timestamps: true },
);

export type Upload = InferSchemaType<typeof uploadSchema>;
export type UploadDoc = HydratedDocument<Upload>;

export const UploadModel = model('Upload', uploadSchema);
