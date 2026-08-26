import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// Conectar a Neo4j (Grafos de Autorización)
const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'password123')
);

const resolvers = {
  Query: {
    validarPermisoAcceso: async (_, { rebeldeId, sectorId }) => {
      const session = driver.session();
      try {
        // Enfoque por Grafos (DDD Contexto de Autorización): Buscar relación de permisos por camino (Path)
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
  }
};

const server = new ApolloServer({
  schema: buildSubgraphSchema({ typeDefs, resolvers })
});

const port = parseInt(process.env.PORT_SEGURIDAD) || 4002;
const { url } = await startStandaloneServer(server, {
  listen: { port }
});

console.log(`🛡️ Subgrafo de Seguridad (Neo4j) levantado exitosamente en: ${url}`);
