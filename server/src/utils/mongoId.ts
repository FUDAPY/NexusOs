import mongoose from 'mongoose';

/**
 * Filtro que encuentra un documento por `_id` de Mongo **o** por `legacyId`
 * (el id original de Firestore).
 *
 * Por que hace falta:
 * el frontend viene de Firestore y manda ids de 20 caracteres
 * (ej. `003Jljv7OSqMjmpcAvgm`), que NO son ObjectId. `findById` con eso tira
 * CastError, asi que cualquier `/:id` fallaba con los ids que el navegador ya
 * tiene guardados y en cache.
 *
 * Durante la transicion conviven las dos formas, por eso el `$or` en lugar de
 * asumir una sola.
 *
 * @param id           Identificador tal como llega del cliente.
 * @param campoLegacy  Campo que guarda el id de Firestore (default `legacyId`).
 */
export const filtroPorId = (id: string, campoLegacy = 'legacyId'): Record<string, unknown> => {
  const limpio = id.trim();
  if (limpio === '') return { _id: null };

  // Un id de Firestore de 20 caracteres no pasa este chequeo (isValidObjectId
  // acepta 24 hex o 12 bytes), asi que cae directo al campo legacy.
  if (mongoose.isValidObjectId(limpio)) {
    return { $or: [{ _id: limpio }, { [campoLegacy]: limpio }] };
  }

  return { [campoLegacy]: limpio };
};
