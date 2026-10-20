import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserModel } from './infrastructure/mongoose-models.js';

const JWT_SECRET = process.env.JWT_SECRET || "ClaveSecretaDelTartaro123";
const SESSION_TTL_SECONDS = 3600; // 1 hora de vida de la sesión

// Paso 3: Middleware de contexto. Se ejecuta en CADA petición entrante.
export const createAuthContext = (redisClient) => async ({ req }) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      // 1. Verificación criptográfica síncrona de la firma
      const decoded = jwt.verify(token, JWT_SECRET);

      // 2. Verificación del estado activo en Redis mediante el jti (JWT ID)
      const sessionKey = `sesion:${decoded.jti}`;
      const activeUser = await redisClient.get(sessionKey);

      if (activeUser) {
        // Token válido Y llave presente en Redis: se inyecta el usuario
        return {
          currentUser: { ...decoded, id: decoded.sub },
          token,
          jti: decoded.jti,
          redisClient
        };
      }
    } catch (err) {
      console.warn("Token inválido o expirado:", err.message);
    }
  }
  // Sin token, o sesión revocada en Redis
  return { currentUser: null, redisClient };
};

// Paso 4: Resolvers de autenticación
export const authResolvers = {
  Query: {
    me: async (_, __, context) => {
      if (!context.currentUser) {
        throw new Error("No estás autenticado o tu sesión ha expirado.");
      }
      // Devolver la información del usuario inyectada en el contexto
      return {
        id: context.currentUser.id,
        nombre: context.currentUser.nombre,
        email: context.currentUser.email
      };
    }
  },
  Mutation: {
    login: async (_, { input }, context) => {
      const { email, password } = input;
      const { redisClient } = context;

      // 1. Buscar al usuario en MongoDB
      const user = await UserModel.findOne({ email });
      if (!user) {
        throw new Error("Credenciales inválidas.");
      }

      // 2. Validar la contraseña con bcrypt
      const validPassword = await bcrypt.compare(password, user.passwordHash);
      if (!validPassword) {
        throw new Error("Credenciales inválidas.");
      }

      // 3. Generar un JTI (JWT ID) único para rastrear la sesión
      const jti = crypto.randomUUID();

      // 4. Firmar el JWT
      const token = jwt.sign(
        {
          sub: user._id.toString(),
          nombre: user.nombre,
          email: user.email,
          jti
        },
        JWT_SECRET,
        { expiresIn: `${SESSION_TTL_SECONDS}s` }
      );

      // 5. Persistir la sesión en Redis con TTL atómico (SET ... EX)
      const sessionKey = `sesion:${jti}`;
      await redisClient.set(sessionKey, user._id.toString(), {
        expiration: { type: 'EX', value: SESSION_TTL_SECONDS } // Expiración automática
      });

      console.log(`[LOGIN SUCCESS] Sesión registrada en Redis: ${sessionKey} (TTL: ${SESSION_TTL_SECONDS}s)`);

      return {
        token,
        user: {
          id: user._id.toString(),
          nombre: user.nombre,
          email: user.email
        }
      };
    },
    logout: async (_, __, context) => {
      if (!context.currentUser || !context.jti) {
        throw new Error("No hay una sesión activa para cerrar.");
      }
      const { jti, redisClient } = context;
      const sessionKey = `sesion:${jti}`;

      // Destrucción inmediata de la llave en Redis (operación O(1))
      await redisClient.del(sessionKey);

      console.log(`[LOGOUT SUCCESS] Llave destruida atómicamente en Redis: ${sessionKey}`);
      return true;
    }
  }
};
