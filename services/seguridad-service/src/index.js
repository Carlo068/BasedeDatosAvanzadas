import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse, GraphQLError } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import neo4j from 'neo4j-driver';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

// Importar modelo de persistencia
import { RebeldeModel } from './infrastructure/mongoose-models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// Constantes de Seguridad
const JWT_SECRET = process.env.JWT_SECRET || 'ClaveSecretaDelTartaro123';
const SESSION_TTL_SECONDS = 3600; // 1 hora de duración para la sesión

// 1. Conectar a MongoDB (Identidades y Credenciales)
const mongoUri = process.env.MONGODB_URI || 'mongodb://admin:password123@localhost:27017/resistencia?authSource=admin';
mongoose.connect(mongoUri)
  .then(() => console.log("🍃 MongoDB (Seguridad Domain - Identidades) conectado exitosamente."))
  .catch(err => console.error("❌ Error al conectar a MongoDB en Seguridad:", err));

// 2. Conectar a Redis Stack (Lista Blanca de Sesiones JTI)
const redisUrl = process.env.REDIS_URL || 'redis://default:password123@localhost:6379';
const redisClient = createClient({ url: redisUrl });
redisClient.on('error', (err) => console.error('❌ Error en el cliente Redis de Seguridad:', err));
await redisClient.connect();
console.log('⚡ Redis Stack (Lista Blanca de Sesiones) conectado exitosamente.');

// 3. Conectar a Neo4j (Grafos de Autorización RBAC)
const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'password123')
);

const resolvers = {
  Query: {
    // =========================================================================
    // CONSULTA PROTEGIDA: ME (Recuperar Perfil del Rebelde Autenticado)
    // =========================================================================
    me: async (_, __, context) => {
      if (!context.currentUser) {
        throw new GraphQLError('No estás autenticado o tu sesión ha sido revocada.', {
          extensions: { code: 'UNAUTHENTICATED' }
        });
      }

      return {
        id: context.currentUser.id,
        nombre: context.currentUser.nombre,
        email: context.currentUser.email,
        rol: context.currentUser.rol
      };
    },

    // =========================================================================
    // AUTORIZACIÓN: VALIDAR PERMISOS EN GRAFOS (Neo4j)
    // =========================================================================
    validarPermisoAcceso: async (_, { rebeldeId, sectorId }) => {
      const session = driver.session();
      try {
        const result = await session.run(
          `MATCH (r:Rebelde {id: $rebeldeId})-[:MIEMBRO_DE]->(c:Celula)-[:TIENE_ACCESO]->(s:Sector {id: $sectorId})
           RETURN count(s) > 0 AS autorizado`,
          { rebeldeId, sectorId }
        );
        return result.records[0].get('autorizado');
      } catch (err) {
        console.error("Error al consultar autorización en Neo4j:", err);
        return false;
      } finally {
        await session.close();
      }
    }
  },

  Mutation: {
    // =========================================================================
    // 1. REGISTRO DE REBELDES (Creación de Credenciales Seguras con bcrypt)
    // =========================================================================
    registrarRebelde: async (_, { nombre, email, password, rol }) => {
      const emailNormalizado = email.trim().toLowerCase();

      const existe = await RebeldeModel.findOne({ email: emailNormalizado });
      if (existe) {
        throw new GraphQLError('El correo del rebelde ya está registrado en el sistema.', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      const nuevoRebelde = new RebeldeModel({
        nombre,
        email: emailNormalizado,
        passwordHash,
        rol: rol || 'GUERRILLERO'
      });

      const doc = await nuevoRebelde.save();
      console.log(`🛡️ Rebelde registrado en la base de datos: ${doc.email} (${doc.rol})`);

      return {
        id: doc._id.toString(),
        nombre: doc.nombre,
        email: doc.email,
        rol: doc.rol
      };
    },

    // =========================================================================
    // 2. LOGIN (Emisión de JWT + Inyección de JTI en Redis Whitelist)
    // =========================================================================
    login: async (_, { input }, context) => {
      const { email, password } = input;
      const { redisClient } = context;

      // Buscar rebelde en MongoDB
      const rebelde = await RebeldeModel.findOne({ email: email.trim().toLowerCase() });
      if (!rebelde) {
        throw new GraphQLError('Credenciales incorrectas.', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      // Validar contraseña con bcrypt
      const validPassword = await bcrypt.compare(password, rebelde.passwordHash);
      if (!validPassword) {
        throw new GraphQLError('Credenciales incorrectas.', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      // Generar identificador único de sesión criptográfico (JTI)
      const jti = crypto.randomUUID();

      // Emitir token JWT con subject (ID), claims de dominio y jti
      const token = jwt.sign(
        {
          sub: rebelde._id.toString(),
          nombre: rebelde.nombre,
          email: rebelde.email,
          rol: rebelde.rol,
          jti
        },
        JWT_SECRET,
        { expiresIn: SESSION_TTL_SECONDS }
      );

      // Registrar sesión en la Lista Blanca de Redis con TTL atómico
      const sessionKey = `sesion:${jti}`;
      await redisClient.set(sessionKey, rebelde._id.toString(), {
        expiration: { type: 'EX', value: SESSION_TTL_SECONDS }
      });
      console.log(`🔑 Sesión iniciada y autorizada en Redis: ${sessionKey}`);

      return {
        token,
        user: {
          id: rebelde._id.toString(),
          nombre: rebelde.nombre,
          email: rebelde.email,
          rol: rebelde.rol
        }
      };
    },

    // =========================================================================
    // 3. LOGOUT (Revocación Inmediata O(1) de la Sesión en Redis)
    // =========================================================================
    logout: async (_, __, context) => {
      if (!context.currentUser || !context.jti) {
        throw new GraphQLError('No existe una sesión activa para cerrar.', {
          extensions: { code: 'UNAUTHENTICATED' }
        });
      }

      const { jti, redisClient } = context;
      const sessionKey = `sesion:${jti}`;

      // Eliminación O(1) de la sesión en memoria RAM
      await redisClient.del(sessionKey);
      console.log(`🚪 Sesión revocada inmediatamente en Redis: ${sessionKey}`);

      return true;
    }
  }
};

// Instanciar Apollo Subgraph
const server = new ApolloServer({
  schema: buildSubgraphSchema({ typeDefs, resolvers })
});

const port = parseInt(process.env.PORT_SEGURIDAD) || 4002;

// Inicio del Subgrafo con Middleware de Contexto
const { url } = await startStandaloneServer(server, {
  listen: { port },
  context: async ({ req }) => {
    const authHeader = req.headers.authorization || '';

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        // 1. Validar la firma matemática del JWT
        const decoded = jwt.verify(token, JWT_SECRET);

        // 2. Validar que el JTI siga presente en la Lista Blanca de Redis
        const sessionKey = `sesion:${decoded.jti}`;
        const activeRebeldeId = await redisClient.get(sessionKey);

        if (activeRebeldeId) {
          return {
            currentUser: { ...decoded, id: decoded.sub },
            token,
            jti: decoded.jti,
            redisClient
          };
        }
      } catch (err) {
        console.warn('⚠️ Token inválido o firma rechazada:', err.message);
      }
    }

    return { currentUser: null, redisClient };
  }
});

console.log(`🛡️ Subgrafo de Seguridad & Autenticación (MongoDB + Redis + Neo4j) en: ${url}`);
