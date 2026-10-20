import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import amqp from 'amqplib';
import { CampamentoModel } from './infrastructure/mongoose-models.js';
import { Campamento } from './domain/entities.js';
import { initRedisOM, campamentoRepository, redisClient } from './infrastructure/redis-om.js';
import { authResolvers, createAuthContext } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// Conectar a MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/resistencia';
mongoose.connect(mongoUri)
  .then(() => console.log("MongoDB (Campamentos Domain) conectado de forma exitosa."))
  .catch(err => console.error("Error al conectar a MongoDB:", err));

// Inicializar Redis OM
await initRedisOM();

// Inicializar conexión con el Broker de Mensajería (RabbitMQ)
let rabbitChannel;
async function initRabbit() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    rabbitChannel = await conn.createChannel();
    await rabbitChannel.assertQueue('transmisiones-auditoria', { durable: true });
    console.log("RabbitMQ conectado. Canal listo para el dominio de Campamentos.");
  } catch (err) {
    console.error("No se pudo establecer conexión con RabbitMQ:", err.message);
  }
}
initRabbit();

const CACHE_TTL_SECONDS = 120; // Tiempo de vida en caché de 2 minutos para los campamentos en Redis OM

// Datos que se guardan en Redis OM (los suministros no se cachean: se cargan bajo demanda desde MongoDB)
const toCacheEntity = (stringId, doc) => ({
  mongoId: stringId,
  nombre: doc.nombre,
  ubicacion: doc.ubicacion,
  capacidad: doc.capacidad
});

// Guarda el campamento en Redis OM y le aplica la política TTL (fallos de caché nunca rompen la consulta)
async function cacheCampamento(stringId, doc, etiqueta) {
  if (!campamentoRepository) return;
  try {
    await campamentoRepository.save(stringId, toCacheEntity(stringId, doc));
    await campamentoRepository.expire(stringId, CACHE_TTL_SECONDS);
    console.log(`${etiqueta} Campamento ${stringId} guardado en Redis con TTL de ${CACHE_TTL_SECONDS}s`);
  } catch (err) {
    console.warn(`⚠️ Error al guardar en Redis OM (${etiqueta}):`, err.message);
  }
}

const resolvers = {
  Query: {
    verCampamento: async (_, { id }) => {
      console.time(`⏱️ Tiempo verCampamento [${id}]`);

      // FASE A: capa de velocidad (Redis OM, en RAM)
      if (campamentoRepository) {
        try {
          let cached = await campamentoRepository.fetch(id);
          if (!cached || !cached.mongoId) {
            cached = await campamentoRepository.search().where('mongoId').equals(id).return.first();
          }
          if (cached && cached.mongoId) {
            console.log(`⚡ [CACHE HIT] Campamento recuperado desde Redis RAM: ${cached.nombre}`);
            console.timeEnd(`⏱️ Tiempo verCampamento [${id}]`);
            return {
              id: cached.mongoId,
              nombre: cached.nombre,
              ubicacion: cached.ubicacion,
              capacidad: cached.capacidad
            };
          }
        } catch (redisErr) {
          console.warn("⚠️ Advertencia al consultar Redis OM:", redisErr.message);
        }
      }

      // FASE B: cache miss -> lectura en MongoDB
      console.log(`🐢 [CACHE MISS] Consultando en MongoDB para ID: ${id}`);
      const doc = await CampamentoModel.findById(id).lean();
      if (!doc) {
        console.timeEnd(`⏱️ Tiempo verCampamento [${id}]`);
        return null;
      }

      // FASE C: hidratación de caché con TTL
      const stringId = doc._id.toString();
      await cacheCampamento(stringId, doc, '💾 [HIDRATACIÓN]');

      console.timeEnd(`⏱️ Tiempo verCampamento [${id}]`);
      return { id: stringId, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad, suministros: doc.suministros };
    },
    allCampamentos: async () => {
      const docs = await CampamentoModel.find({}).lean();
      return docs.map(doc => ({ id: doc._id.toString(), nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad, suministros: doc.suministros }));
    },
    reporteGlobalArsenal: async () => {
        try {
          // Ejecución del pipeline de agregación física en la base de datos
          const resultado = await CampamentoModel.aggregate([
            // Etapa 1: Aplanar el arreglo de suministros incrustados
            {
              $unwind: "$suministros"
            },
            // Etapa 2: Agrupar por categoría y realizar cálculos métricos
            {
              $group: {
                _id: "$suministros.categoria", // Llave de agrupación obligatoria
                totalSuministros: { $sum: "$suministros.cantidad" }, // Acumulador matemático
                campamentosAsociados: { $addToSet: "$nombre" } // Acumulador de valores únicos
              }
            },
            // Etapa 3: Ordenar los resultados por volumen de forma descendente
            {
              $sort: { totalSuministros: -1 }
            }
          ]);

          // Mapear los datos de salida del pipeline (_id) al contrato tipado de GraphQL
          return resultado.map(item => ({
            categoria: item._id, // El _id de la agregación contiene la categoría
            totalSuministros: item.totalSuministros,
            campamentosAsociados: item.campamentosAsociados
          }));

        } catch (err) {
          console.error("❌ Error catastrófico en el pipeline analítico:", err.message);
          throw new Error("No se pudo compilar el reporte del arsenal en el Tártaro.");
        }
    },
  },
  Mutation: {
    registrarCampamento: async (_, { nombre, ubicacion, capacidad }) => {
      // Aplicación de DDD: Validar reglas de negocio utilizando la clase pura del dominio
      const campamentoDominio = new Campamento(null, nombre, ubicacion, capacidad);
      campamentoDominio.validarUbicacionSegura();

      // Guardar en la persistencia transaccional
      const nuevoCampamento = new CampamentoModel({ nombre, ubicacion, capacidad });
      const doc = await nuevoCampamento.save();
      const stringId = doc._id.toString();

      // Write-Through a Redis OM
      await cacheCampamento(stringId, doc, '⚡ [WRITE-THROUGH]');

      // Enviar de forma asíncrona un Evento de Dominio a la cola de mensajería (RabbitMQ) para auditoría
      if (rabbitChannel) {
        const event = {
          event: "CAMPAMENTO_REGISTRADO",
          payload: { id: stringId, nombre: doc.nombre, fecha: new Date() }
        };
        rabbitChannel.sendToQueue('transmisiones-auditoria', Buffer.from(JSON.stringify(event)), { persistent: true });
        console.log("Evento 'CAMPAMENTO_REGISTRADO' enviado asíncronamente al broker.");
      }

      return { id: stringId, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad };
    },

    registrarSuministro: async (_, { campamentoId, nombre, cantidad, categoria }) => {
      // 1. Buscar el campamento padre por ID
      const campamento = await CampamentoModel.findById(campamentoId);
      if (!campamento) {
        throw new Error("El campamento de destino no existe en el Tártaro.");
      }

      // 2. Crear el objeto del subdocumento
      const nuevoSuministro = {
        nombre,
        cantidad,
        categoria
      };

      // 3. Insertar el suministro directamente al arreglo incrustado
      campamento.suministros.push(nuevoSuministro);

      // 4. Guardar el documento padre de forma asíncrona
      const campamentoActualizado = await campamento.save();

      // 5. Obtener el suministro recién guardado (para retornar su _id generado por Mongo)
      const suministroGuardado = campamentoActualizado.suministros[campamentoActualizado.suministros.length - 1];

      return {
        id: suministroGuardado._id,
        nombre: suministroGuardado.nombre,
        cantidad: suministroGuardado.cantidad,
        categoria: suministroGuardado.categoria
      };
    }
  },
  Campamento: {
    // Los suministros no viven en Redis: si el padre viene de caché, se cargan bajo demanda desde MongoDB
    suministros: async (parent) => {
      let lista = parent.suministros;
      if (!lista) {
        const doc = await CampamentoModel.findById(parent.id).lean();
        lista = doc?.suministros ?? [];
      }
      return lista.map(s => ({
        id: (s._id ?? s.id).toString(),
        nombre: s.nombre,
        cantidad: s.cantidad,
        categoria: s.categoria
      }));
    },
    __resolveReference: async (reference) => {
      if (campamentoRepository) {
        try {
          const cached = await campamentoRepository.fetch(reference.id);
          if (cached && cached.mongoId) {
            return {
              id: cached.mongoId,
              nombre: cached.nombre,
              ubicacion: cached.ubicacion,
              capacidad: cached.capacidad
            };
          }
        } catch (err) {
          console.warn("⚠️ Advertencia al resolver referencia desde Redis OM:", err.message);
        }
      }
      const doc = await CampamentoModel.findById(reference.id).lean();
      return doc ? { id: doc._id.toString(), nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad, suministros: doc.suministros } : null;
    }
  }
};

// Combinar los resolvers del dominio con los de autenticación (me, login, logout)
const allResolvers = {
  ...resolvers,
  Query: { ...resolvers.Query, ...authResolvers.Query },
  Mutation: { ...resolvers.Mutation, ...authResolvers.Mutation }
};

const server = new ApolloServer({
  schema: buildSubgraphSchema({ typeDefs, resolvers: allResolvers })
});

const port = parseInt(process.env.PORT_CAMPAMENTOS) || 4001;
const { url } = await startStandaloneServer(server, {
  listen: { port },
  // Middleware de contexto: se ejecuta en CADA petición entrante (JWT + sesión activa en Redis)
  context: createAuthContext(redisClient)
});

console.log(`🏕️ Subgrafo de Campamentos levantado exitosamente en: ${url}`);

async function testPersistencia() {
  try {
    // 1. Escritura: Forjado de un nuevo campamento
    const nuevoCampamiento = new CampamentoModel({
      nombre: "Búnker de las Parcas",
      ubicacion: "Coordenadas Subterráneas S-3",
      capacidad: 85
    });

    // Guardado físico asíncrono
    const campamentoGuardado = await nuevoCampamiento.save();
    console.log("💾 Campamento guardado con éxito en los Tomos:", campamentoGuardado._id);

    // 2. Lectura: Verificación del documento escrito
    const campamentoPersistido = await CampamentoModel.findOne({ _id: campamentoGuardado._id });
    console.log("🔍 Campamento recuperado de MongoDB:", campamentoPersistido.nombre);

  } catch (err) {
    console.error("❌ Error de validación o persistencia:", err.message);
  }
}
testPersistencia();
