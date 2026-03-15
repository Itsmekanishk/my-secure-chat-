const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  senderId: { type: String, required: true },
  senderPublicKey: { type: String, required: true },
  encryptedPayloads: { type: mongoose.Schema.Types.Mixed, default: {} }, 
  timestamp: { type: Date, default: Date.now, expires: 86400 }, // TTL Index: Auto-deletes exactly 24 hours (86400 seconds) after creation
  isMedia: { type: Boolean, default: false },
  mediaUrl: { type: String },
  groupId: { type: String, default: null }
});

module.exports = mongoose.model('Message', messageSchema);
