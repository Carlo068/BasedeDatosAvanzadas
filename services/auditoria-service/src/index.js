import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cassandra from 'cassandra-driver';
import amqp from 'amqplib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

const scyllaHost = process.env.SCYLLADB_CONTACT_POINTS || '127.0.0.1';
const scyllaPort = parseInt(process.env.SCYLLADB_PORT) || 9042;

// Conectar a ScyllaDB (Persistencia de Auditoría Inmutable)
const scyllaClient = new cassandra.Client({
  contactPoints: [scyllaHost],
  localDataCenter: 'datacenter1',
  keyspace: 'system', // Keyspace por defecto para inicialización
  protocolOptions: { port: scyllaPort }
});

async function initScyllaSchema() {
  try {
    await scyllaClient.connect();
    // Inicializar keyspace y tabla del dominio de telemetría inmutable (Estelas de los Caídos)
    await scyllaClient.execute(`
      CREATE KEYSPACE IF NOT EXISTS auditoria 
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    `);
    
    const clientAudit = new cassandra.Client({
      contactPoints: [scyllaHost],
      localDataCenter: 'datacenter1',
      keyspace: 'auditoria',
      protocolOptions: { port: scyllaPort }
    });
    await clientAudit.connect();
    
    await clientAudit.execute(`
      CREATE TABLE IF NOT EXISTS logs_auditoria (
        id uuid,
        evento text,
        detalle text,
        fecha timestamp,
        PRIMARY KEY (id)
      )
    `);
    console.log("ScyllaDB (Dominio de Auditoría) conectado y esquema de base de datos verificado.");
    return clientAudit;
  } catch (err) {
    console.warn("No se pudo iniciar el esquema en ScyllaDB de forma local (asegúrate de que el contenedor de ScyllaDB esté corriendo):", err.message);
    return null;
  }
}

const auditDb = await initScyllaSchema();

// Iniciar Consumidor de RabbitMQ para procesar Eventos de Dominio asíncronamente (Fire-and-forget)
async function startRabbitConsumer() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    const channel = await conn.createChannel();
    await channel.assertQueue('transmisiones-auditoria', { durable: true });
    
    console.log("📥 Worker de Auditoría esperando eventos en la cola...");
    
    channel.consume('transmisiones-auditoria', async (msg) => {
      if (msg !== null) {
        const content = JSON.parse(msg.content.toString());
        console.log("Evento recibido de la cola:", content);
        
        if (auditDb) {
          // Grabar asíncronamente en ScyllaDB (Wide-Column inmutable)
          const query = `
            INSERT INTO logs_auditoria (id, evento, detalle, fecha)
            VALUES (uuid(), ?, ?, toTimestamp(now()))
          `;
          await auditDb.execute(query, [content.event, JSON.stringify(content.payload)], { prepare: true });
          console.log("💾 Registro guardado eternamente en ScyllaDB.");
        }
        
        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error("No se pudo iniciar el consumidor asíncrono de RabbitMQ:", err.message);
  }
}
startRabbitConsumer();

const resolvers = {
  Query: {
    buscarLogsAuditoria: async (_, { limite }) => {
      if (!auditDb) return [];
      try {
        const result = await auditDb.execute(`SELECT * FROM logs_auditoria LIMIT ${limite}`);
        return result.rows.map(row => ({
          id: row.id.toString(),
          evento: row.evento,
          detalle: row.detalle,
          fecha: row.fecha.toISOString()
        }));
      } catch (err) {
        console.error("Error al consultar ScyllaDB:", err);
        return [];
      }
    }
  }
};

const server = new ApolloServer({
  schema: buildSubgraphSchema({ typeDefs, resolvers })
});

const port = parseInt(process.env.PORT_AUDITORIA) || 4003;
const { url } = await startStandaloneServer(server, {
  port
});

console.log(`📊 Subgrafo de Auditoría (ScyllaDB + RabbitMQ Consumer) levantado exitosamente en: ${url}`);
