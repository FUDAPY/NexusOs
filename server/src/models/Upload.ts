import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';


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
