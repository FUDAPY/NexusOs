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

  /* UN $or ACA ROMPIA LOS FILTROS QUE YA TENIAN $or.
     Antes esto devolvia { $or: [{ _id }, { legacyId }] }. Cuando ese filtro se combinaba con
     otro que tambien traia un $or (los del arqueo), el objeto quedaba con DOS claves $or: la
     segunda pisa a la primera en silencio, y el casteo de Mongoose terminaba mirando un objeto:
       Valor invalido para el campo "_id": [object Object]
     No hace falta: `isValidObjectId` ya decide cual de los dos campos usar. Un id de ObjectId
     va contra _id; un id de Firestore (20 caracteres, no valido) va contra el campo legacy. */
  if (mongoose.isValidObjectId(limpio)) {
    return { _id: limpio };
  }

  return { [campoLegacy]: limpio };
};
