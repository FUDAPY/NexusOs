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

  /* El $or es A PROPOSITO y lo cubre tests/mongoId.test.ts: un documento puede tener _id y
     ademas guardar su id viejo de Firestore en legacyId, y hay que encontrarlo por cualquiera
     de los dos. Intentar "simplificarlo" a un solo campo rompe ese caso (y el test lo atrapa).
     OJO AL COMBINARLO: si el filtro que lo recibe ya trae un $or, hay que envolver ESTE en un
     $and. Dos claves $or en el mismo objeto no se suman: la segunda pisa a la primera en
     silencio, y el casteo termina mirando un objeto (Valor invalido para el campo "_id"). */
  if (mongoose.isValidObjectId(limpio)) {
    return { $or: [{ _id: limpio }, { [campoLegacy]: limpio }] };
  }

  return { [campoLegacy]: limpio };
};
