import mongoose from 'mongoose';

// Definición de las reglas físicas del documento
const CampamentoSchema = new mongoose.Schema({
  nombre: { 
    type: String, 
    required: [true, 'El nombre del campamento es obligatorio para la resistencia.'] 
  },
  ubicacion: { 
    type: String, 
    required: [true, 'La ubicación es crítica para evitar el radar enemigo.'] 
  },
  capacidad: { 
    type: Number, 
    required: [true, 'Debes definir la capacidad de sobrevivientes.'],
    min: [1, 'Un campamento debe poder albergar al menos a un guerrero.']
  }
}, { 
  timestamps: true // Agrega automáticamentecreatedAt y updatedAt
});

// Forjado del Modelo de Datos
export const CampamentoModel = mongoose.model('Campamento', CampamentoSchema);
