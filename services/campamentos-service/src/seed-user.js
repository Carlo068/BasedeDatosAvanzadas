// Crea (o actualiza) el usuario de demostración para probar login/me/logout en Apollo Sandbox.
// Uso: npm run seed:user --workspace=services/campamentos-service
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { UserModel } from './infrastructure/mongoose-models.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/resistencia';

const DEMO_USER = {
  nombre: 'Rebelde del Tártaro',
  email: 'rebelde@tartaro.ulsa.mx',
  password: 'PasswordSeguro123!'
};

try {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
  const passwordHash = await bcrypt.hash(DEMO_USER.password, 10);
  await UserModel.findOneAndUpdate(
    { email: DEMO_USER.email },
    { nombre: DEMO_USER.nombre, email: DEMO_USER.email, passwordHash },
    { upsert: true, new: true }
  );
  console.log(`✅ Usuario de demostración listo: ${DEMO_USER.email}`);
} catch (err) {
  console.error('❌ No se pudo crear el usuario de demostración:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
