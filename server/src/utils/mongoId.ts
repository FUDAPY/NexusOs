import mongoose from 'mongoose';


export const filtroPorId = (id: string, campoLegacy = 'legacyId'): Record<string, unknown> => {
  const limpio = id.trim();
  if (limpio === '') return { _id: null };

  
  if (mongoose.isValidObjectId(limpio)) {
    return { $or: [{ _id: limpio }, { [campoLegacy]: limpio }] };
  }

  return { [campoLegacy]: limpio };
};
