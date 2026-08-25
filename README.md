# La Resistencia del Tártaro (Arquitectura de Microservicios Políglotas y DDD)

Este proyecto integrador demuestra de manera empírica cómo un **Backend Desacoplado (Headless)** puede organizarse utilizando **Domain-Driven Design (DDD) / Programación Orientada al Dominio** coexistiendo con una arquitectura de **Microservicios Políglotas** federados por una **API Gateway (Apollo Server)**.

## Arquitectura del Sistema

El sistema se divide en **tres contextos acotados (Bounded Contexts)** que actúan como microservicios aislados, cada uno con su propia persistencia especializada (Persistencia Políglota) y modelo de dominio, comunicados de manera asíncrona a través de un broker de mensajería (RabbitMQ):

1.  **Campamentos Service (Core Domain)**: Gestiona la persistencia transaccional de los campamentos rebeldes. Utiliza **MongoDB** por su flexibilidad documental.
2.  **Seguridad Service (Security Domain)**: Controla el acceso basado en roles (RBAC) y relaciones de confianza. Utiliza **Neo4j** para modelar grafos de permisos.
3.  **Auditoría Service (Audit Domain)**: Registra la telemetría e historial de transmisiones de forma inmutable. Utiliza **ScyllaDB** por su altísima velocidad de escritura.

La puerta de enlace o **API Gateway** realiza la federación de esquemas (Apollo Federation) para presentar un único esquema unificado (Supergraph) al frontend.

---

## Requisitos Previos

1.  **Node.js** (Versión 18 o superior)
2.  **Docker & Docker Compose** (para levantar la infraestructura de bases de datos y RabbitMQ)

---

## Instrucciones de Instalación y Arranque

### Paso 1: Levantar las Bases de Datos y el Broker de Mensajería
Ejecuta el siguiente comando para iniciar MongoDB, Redis, Neo4j, ScyllaDB y RabbitMQ:
```bash
docker compose -f docker-compose-v2.yml up -d
```

### Paso 2: Instalar Dependencias del Monorepo
Desde la raíz del proyecto, instala todos los módulos requeridos por los workspaces de forma unificada:
```bash
npm install
```

### Paso 3: Arrancar el Ecosistema en Modo Desarrollo
Inicia todos los microservicios y la API Gateway simultáneamente con recarga automática (*hot-reload*):
```bash
npm run dev
```

El portal de GraphQL (Playground) estará disponible en: **http://localhost:4000/graphql**
La consola web de administración de RabbitMQ estará en: **http://localhost:15672** (guest / guest)
La interfaz de RedisInsight para ver la caché estará en: **http://localhost:8001**
