
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { User } from '../src/models/index.js';

const MIN_LARGO = 6;

const main = async (): Promise<void> => {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  const password = process.argv[3] ?? '';

  if (email === '' || password === '') {
    console.error('Uso: npm run auth:pass -- <email> <password>');
    process.exitCode = 1;
    return;
  }

  if (password.length < MIN_LARGO) {
    console.error(`La contrasena tiene que tener al menos ${MIN_LARGO} caracteres.`);
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(env.MONGO_URI);

  try {
    // passwordHash esta oculto por defecto (select: false); hay que pedirlo.
    const user = await User.findOne({ email }).select('+passwordHash');

    if (!user) {
      console.error(`No existe ningun usuario con el email ${email}.`);
      console.error('Estos son los usuarios con rol admin o supervisor:');
      const admins = await User.find({ rol: { $in: ['admin', 'supervisor'] } })
        .select('nombre email rol passwordHash')
        .lean()
        .exec();
      for (const admin of admins) {
        const tiene = (admin.passwordHash ?? '') !== '' ? 'con contrasena' : 'SIN contrasena';
        console.error(`  - ${admin.email} (${admin.rol}, ${tiene}) ${admin.nombre}`);
      }
      process.exitCode = 1;
      return;
    }

    const yaTenia = (user.passwordHash ?? '') !== '';
    user.passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
    user.passwordActualizadoEn = new Date();
    await user.save();

    console.log(
      `${yaTenia ? 'Contrasena actualizada' : 'Contrasena establecida'} para ` +
        `${user.nombre} <${email}> (rol ${user.rol}).`,
    );
  } finally {
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  console.error('Fallo el script:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
