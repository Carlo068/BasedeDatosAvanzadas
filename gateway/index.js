import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';

// Propaga el header Authorization (JWT) del cliente hacia cada subgrafo
class AuthenticatedDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }) {
    if (context.authorization) {
      request.http.headers.set('authorization', context.authorization);
    }
  }
}

// El Gateway actúa como agregador de los microservicios locales (subgraphs)
const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [
      { name: 'campamentos', url: `http://localhost:${process.env.PORT_CAMPAMENTOS || 4001}/graphql` },
      { name: 'seguridad', url: `http://localhost:${process.env.PORT_SEGURIDAD || 4002}/graphql` },
      { name: 'auditoria', url: `http://localhost:${process.env.PORT_AUDITORIA || 4003}/graphql` }
    ],
  }),
  buildService({ url }) {
    return new AuthenticatedDataSource({ url });
  },
});

const server = new ApolloServer({
  gateway,
});

const port = parseInt(process.env.PORT_GATEWAY) || 4000;
const { url } = await startStandaloneServer(server, {
  listen: { port },
  context: async ({ req }) => ({ authorization: req.headers.authorization }),
});

console.log(`🚀 API Gateway (Supergraph) unificada y lista en: ${url}`);
