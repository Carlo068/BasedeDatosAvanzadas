import mongoose from 'mongoose';

// 1. Definir el subesquema de Suministro primero
const SuministroSchema = new mongoose.Schema({
  nombre: { 
    type: String, 
    required: [true, 'El suministro necesita un nombre (ej. Buster Sword).'] 
  },
  cantidad: { 
    type: Number, 
    required: [true, 'Debes definir la cantidad.'],
    min: [0, 'No puedes tener cantidades negativas de suministros.']
  },
  categoria: { 
    type: String, 
    required: [true, 'La categoría es obligatoria.'],
    enum: ['ARMAMENTO', 'VIVERES', 'MEDICINA'] // Validación de catálogo místico
  }
});

// 2. Modificar el esquema del Campamento para incrustar el arreglo de suministros
const CampamentoSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  ubicacion: { type: String, required: true },
  capacidad: { type: Number, required: true },
  suministros: [SuministroSchema] // ¡Incrustación NoSQL directa!
}, { 
  timestamps: true // Agrega automáticamentecreatedAt y updatedAt
});

// Forjado del Modelo de Datos
export const CampamentoModel = mongoose.model('Campamento', CampamentoSchema);

// Usuarios con credenciales para la autenticación JWT + Redis (el hash nunca se expone por GraphQL)
const UserSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }
}, {
  timestamps: true
});

export const UserModel = mongoose.model('User', UserSchema);
