import { createClient } from 'redis';
import { Schema, Repository } from 'redis-om';

// 1. Conexión al cliente oficial de Redis Stack
const localRedisUrl = 'redis://default:password123@localhost:6379';  
const redisUrl = process.env.REDIS_URL || localRedisUrl;
export const redisClient = createClient({ url: redisUrl });

redisClient.on('error', (err) => console.error('❌ Error en el cliente Redis:', err));

// 2. Definición del Esquema Redis OM con estructura nativa JSON
export const campamentoSchema = new Schema('Campamento', {
  mongoId:   { type: 'string' },
  nombre:    { type: 'string' },
  ubicacion: { type: 'string' },
  capacidad: { type: 'number' }
}, { 
  dataStructure: 'JSON' // Almacena directamente como objeto JSON en RAM
});

// 3. Inicialización del Repositorio
export let campamentoRepository;
export async function initRedisOM() {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
      console.log('⚡ Redis Stack (Speed Layer) conectado exitosamente.');
    }
    
    campamentoRepository = new Repository(campamentoSchema, redisClient);
    
    // 4. Creación de índices en memoria con RediSearch O(log N)
    await campamentoRepository.createIndex();
    console.log('🔍 Índices RediSearch en memoria creados / verificados.');
  } catch (error) {
    console.error('⚠️ No se pudo inicializar Redis OM:', error.message);
  }
}