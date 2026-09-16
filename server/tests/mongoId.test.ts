import { describe, expect, it } from 'vitest';
import { filtroPorId } from '../src/utils/mongoId.js';

/**
 * El frontend viene de Firestore y manda ids de 20 caracteres que NO son
 * ObjectId. Antes todo `/:id` usaba findById, que con esos ids tira CastError,
 * asi que cada pantalla fallaba con los ids que el navegador ya tenia en cache.
 */
describe('filtroPorId', () => {
  it('acepta un ObjectId de Mongo y busca tambien por legacyId', () => {
    const id = '65f1c0a1b2c3d4e5f6071829';
    expect(filtroPorId(id)).toEqual({ $or: [{ _id: id }, { legacyId: id }] });
  });

  it('acepta un id de Firestore de 20 caracteres por legacyId', () => {
    const id = '003Jljv7OSqMjmpcAvgm';
    expect(filtroPorId(id)).toEqual({ legacyId: id });
  });

  it('no usa $or con un id de Firestore (no es ObjectId)', () => {
    const filtro = filtroPorId('ysei6UDGoUvZVWBRFAAl');
    expect(filtro['$or']).toBeUndefined();
    expect(filtro['legacyId']).toBe('ysei6UDGoUvZVWBRFAAl');
  });

  it('recorta espacios y no matchea nada con id vacio', () => {
    expect(filtroPorId('  003Jljv7OSqMjmpcAvgm  ')).toEqual({ legacyId: '003Jljv7OSqMjmpcAvgm' });
    // _id: null nunca matchea, asi que un id vacio da 404 en vez de devolver
    // el primer documento de la coleccion.
    expect(filtroPorId('')).toEqual({ _id: null });
  });

  it('permite cambiar el campo legacy (ej. users.uid)', () => {
    expect(filtroPorId('abc123', 'uid')).toEqual({ uid: 'abc123' });
  });
});
