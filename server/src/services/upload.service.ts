import { UploadModel } from '../models/Upload.js';
import { AppError } from '../utils/response.js';
import { filtroPorId } from '../utils/mongoId.js';

/** Lo que el panel necesita: logos, fotos de producto y fotos de tickets. */
const MIMES_PERMITIDOS = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
];

/**
 * Tope por archivo. Esta por debajo del limite del parser de esta ruta (6mb) porque en base64
 * el peso crece ~33%: si se aceptara hasta el tope del parser, el rechazo lo daria el parser
 * con un error generico en vez de un mensaje que se entienda.
 */
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

/**
 * Guarda una imagen y devuelve la URL con la que se muestra.
 *
 * Reemplaza a Firebase Storage (ver el comentario del modelo). Devuelve una URL RELATIVA a
 * proposito: el mismo proceso sirve el panel y la API, asi que una ruta relativa resuelve bien
 * sin depender de como el proxy reporte el protocolo (con https mal detectado, una URL absoluta
 * daria contenido mixto y la imagen no cargaria).
 */
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

  /* Llegan las dos formas: data URL ("data:image/png;base64,AAAA") o base64 pelado. */
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

/**
 * Devuelve la imagen cruda para servirla. Publica a proposito: las pantallas la muestran con
 * un <img src>, que no manda token. El id es un ObjectId (no adivinable) y las imagenes del
 * panel no son secretos.
 */
export const obtenerImagen = async (id: string) => {
  const limpio = String(id ?? '').trim();
  if (limpio === '') throw new AppError('Falta la imagen', 400, 'MISSING_ID');

  /* filtroPorId evita que un id con formato invalido termine en un CastError de Mongo (que
     saldria como 500 cuando en realidad es un 404). */
  const subida = await UploadModel.findOne(filtroPorId(limpio)).exec();
  if (!subida) throw new AppError('No existe esa imagen', 404, 'IMAGEN_INEXISTENTE');
  return subida;
};
