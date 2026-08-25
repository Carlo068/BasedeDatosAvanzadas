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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// Conectar a MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/resistencia';
mongoose.connect(mongoUri)
  .then(() => console.log("MongoDB (Campamentos Domain) conectado de forma exitosa."))
  .catch(err => console.error("Error al conectar a MongoDB:", err));

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

const resolvers = {
  Query: {
    verCampamento: async (_, { id }) => {
      const doc = await CampamentoModel.findById(id);
      return doc ? { id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad } : null;
    },
    allCampamentos: async () => {
      const docs = await CampamentoModel.find({});
      return docs.map(doc => ({ id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad }));
    }
  },
  Mutation: {
    registrarCampamento: async (_, { nombre, ubicacion, capacidad }) => {
      // Aplicación de DDD: Validar reglas de negocio utilizando la clase pura del dominio
      const campamentoDominio = new Campamento(null, nombre, ubicacion, capacidad);
      campamentoDominio.validarUbicacionSegura();

      // Guardar en la persistencia transaccional
      const nuevoCampamento = new CampamentoModel({ nombre, ubicacion, capacidad });
      const doc = await nuevoCampamento.save();

      // Enviar de forma asíncrona un Evento de Dominio a la cola de mensajería (RabbitMQ) para auditoría
      if (rabbitChannel) {
        const event = {
          event: "CAMPAMENTO_REGISTRADO",
          payload: { id: doc._id, nombre: doc.nombre, fecha: new Date() }
        };
        rabbitChannel.sendToQueue('transmisiones-auditoria', Buffer.from(JSON.stringify(event)), { persistent: true });
        console.log("Evento 'CAMPAMENTO_REGISTRADO' enviado asíncronamente al broker.");
      }

      return { id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad };
    }
  },
  Campamento: {
    __resolveReference: async (reference) => {
      const doc = await CampamentoModel.findById(reference.id);
      return doc ? { id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad } : null;
    }
  }
};

const server = new ApolloServer({
  schema: buildSubgraphSchema({ typeDefs, resolvers })
});

const port = parseInt(process.env.PORT_CAMPAMENTOS) || 4001;
const { url } = await startStandaloneServer(server, {
  port
});

console.log(`🏕️ Subgrafo de Campamentos levantado exitosamente en: ${url}`);
