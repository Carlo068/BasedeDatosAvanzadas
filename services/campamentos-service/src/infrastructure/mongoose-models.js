import mongoose from 'mongoose';

// Esquema físico de la base de datos (MongoDB)
const CampamentoSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  ubicacion: { type: String, required: true },
  capacidad: { type: Number, required: true }
});

export const CampamentoModel = mongoose.model('Campamento', CampamentoSchema);
