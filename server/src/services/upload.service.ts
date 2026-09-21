import { UploadModel } from '../models/Upload.js';
import { AppError } from '../utils/response.js';
import { filtroPorId } from '../utils/mongoId.js';


const MIMES_PERMITIDOS = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
  
  'image/svg+xml',
];


const TAMANO_MAXIMO = 4 * 1024 * 1024;

export interface GuardarImagenInput {
  carpeta?: string;
  nombre?: string;
  mime?: string;
  datosBase64?: string;
  subidoPor?: string;
}

export interface ImagenGuardada {
  id: string;
  url: string;
  mime: string;
  tamano: number;
}


export const guardarImagen = async (
  input: GuardarImagenInput,
  prefijoApi: string,
): Promise<ImagenGuardada> => {
  const mime = String(input.mime ?? '').trim().toLowerCase();
  if (!MIMES_PERMITIDOS.includes(mime)) {
    throw new AppError(
      `Formato no permitido (${mime || 'sin tipo'}). Se aceptan imagenes: ${MIMES_PERMITIDOS.join(', ')}`,
      422,
      'MIME_NO_PERMITIDO',
    );
  }

  const base64 = String(input.datosBase64 ?? '');
  if (base64 === '') throw new AppError('Falta la imagen', 400, 'MISSING_DATOS');

  
  const limpio = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const datos = Buffer.from(limpio, 'base64');

  if (datos.length === 0) throw new AppError('La imagen llego vacia', 422, 'IMAGEN_VACIA');
  if (datos.length > TAMANO_MAXIMO) {
    throw new AppError(
      `La imagen supera el maximo de ${Math.round(TAMANO_MAXIMO / 1024 / 1024)} MB`,
      413,
      'IMAGEN_DEMASIADO_GRANDE',
    );
  }

  const subida = await UploadModel.create({
    carpeta: String(input.carpeta ?? 'general'),
    nombre: String(input.nombre ?? ''),
    mime,
    tamano: datos.length,
    datos,
    subidoPor: String(input.subidoPor ?? ''),
  });

  const id = String(subida._id);
  return { id, url: `${prefijoApi}/uploads/${id}`, mime, tamano: datos.length };
};


export const obtenerImagen = async (id: string) => {
  const limpio = String(id ?? '').trim();
  if (limpio === '') throw new AppError('Falta la imagen', 400, 'MISSING_ID');

  
  const subida = await UploadModel.findOne(filtroPorId(limpio)).exec();
  if (!subida) throw new AppError('No existe esa imagen', 404, 'IMAGEN_INEXISTENTE');
  return subida;
};
