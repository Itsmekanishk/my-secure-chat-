const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  senderId: { type: String, required: true },
  senderPublicKey: { type: String, required: true },
  encryptedPayloads: { type: mongoose.Schema.Types.Mixed, default: {} }, // recipientId or recipientId__N -> { cipherText, iv }
  timestamp: { type: Date, default: Date.now },
  // Adding fields needed for Phase 4 (Encryption) later
  isMedia: { type: Boolean, default: false },
  mediaUrl: { type: String },
  groupId: { type: String, default: null } // 'global' for default room, or a Group ObjectId string
});

module.exports = mongoose.model('Message', messageSchema);
