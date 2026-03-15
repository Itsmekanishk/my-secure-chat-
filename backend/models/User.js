const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true,
    minlength: 3
  },
  password: { 
    type: String, 
    required: true 
  },
  nickname: {
    type: String,
    required: true
  },
  color1: { type: String, default: '#00ff9d' },
  color2: { type: String, default: '#a855f7' },
  sym: { type: String, default: 'U' },
  avatar: { type: String, default: '/avatars/user1.png' },
  googleUid: { type: String, unique: true, sparse: true },
  email: { type: String },
  publicKeyBase64: { type: String }, // To store their current ECDH public key
  status: {  
    type: String, 
    enum: ['online', 'offline', 'away'],
    default: 'offline'
  },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

// Hash password before saving (async hook: no next — return or throw)
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to check password validity
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
