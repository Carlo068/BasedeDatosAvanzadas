import mongoose from 'mongoose';

// Identidad y credenciales del Rebelde (el hash nunca se expone por GraphQL)
const RebeldeSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: { type: String, required: true },
  rol: { type: String, default: 'GUERRILLERO' }
}, {
  timestamps: true
});

export const RebeldeModel = mongoose.model('Rebelde', RebeldeSchema);
