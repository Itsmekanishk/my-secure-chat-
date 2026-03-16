const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const groupRoutes = require('./routes/groups');
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);

const server = http.createServer(app);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('[✓] Connected to MongoDB Atlas'))
.catch((err) => console.error('[x] MongoDB connection error:', err));

const Message = require('./models/Message');
const Group = require('./models/Group');

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL ? [process.env.CLIENT_URL, "http://localhost:5173"] : "*", // Allow specified client or fallback to all for local dev
    methods: ["GET", "POST"]
  }
});

// Basic route to check if server is running
app.get('/', (req, res) => {
  res.send('CipherChat Secure Relay Server is running.');
});

const User = require('./models/User');

// Store connected users (socket.id -> userData)
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log(`[+] New Connection: ${socket.id}`);

  // When a user logs in and joins the secure relay
  socket.on('join_relay', async (userData) => {
    connectedUsers.set(socket.id, userData);
    console.log(`[+] User Joined Node: ${userData.nickname} (${socket.id})`);
    
    // Update DB status to online
    if (userData.uid) {
       await User.findByIdAndUpdate(userData.uid, { status: 'online' });
    }
    
    // Emit the change globally to notify ALL clients to update their offline/online sidebars
    io.emit('user_status_change', { uid: userData.uid, status: 'online' });
  });
  
  // Helper: get current active users in a room (normalize uid to string for consistent encryption keys)
  const getRoomActiveUsers = async (groupId) => {
    const roomSockets = await io.in(groupId).fetchSockets();
    return roomSockets
      .map(s => connectedUsers.get(s.id))
      .filter(Boolean)
      .map(u => ({
        ...u,
        uid: String(u.uid ?? u.id ?? u._id ?? ''),
        publicKeyBase64: u.publicKeyBase64 || null
      }));
  };

  socket.on('get_active_users', (payload, callback) => {
    const groupId = (payload && payload.groupId != null) ? payload.groupId : 'global';
    if (typeof callback !== 'function') return;
    getRoomActiveUsers(groupId)
      .then(users => callback(users))
      .catch(err => {
        console.error('[x] get_active_users error:', err);
        callback([]);
      });
  });

  // When a user selects a specific group channel
  socket.on('join_group', async ({ groupId }) => {
     const previousRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
     previousRooms.forEach(room => socket.leave(room)); // Leave previous group

     // ── Membership guard (skip for the open 'global' room) ──
     if (groupId !== 'global') {
       const userData = connectedUsers.get(socket.id);
       const userId = userData && String(userData.uid ?? userData.id ?? userData._id ?? '');
       if (!userId) {
         socket.emit('unauthorized', { message: 'Authentication required to join this group.' });
         return;
       }
       const group = await Group.findOne({ _id: groupId, members: userId });
       if (!group) {
         console.warn(`[!] Blocked ${socket.id} (${userId}) from joining group ${groupId} — not a member`);
         socket.emit('unauthorized', { message: 'You are not a member of this group.' });
         return;
       }
     }

     socket.join(groupId);
     console.log(`[+] Socket ${socket.id} joined Group ${groupId}`);
     
     const roomActiveUsers = await getRoomActiveUsers(groupId);
     
     // Send recent messages for this group only
     try {
       const recentMessages = await Message.find({ groupId }).sort({ timestamp: 1 }).limit(100);
       socket.emit('load_history', recentMessages);
       io.to(groupId).emit('active_users', roomActiveUsers);
     } catch (err) {
       console.error('[x] Error loading group history:', err);
     }
  });

  // When a user sends an encrypted message
  socket.on('send_message', async (encryptedPayload) => {
    const groupId = encryptedPayload.groupId;
    console.log(`[->] Routing encrypted payload from ${socket.id} to Group ${groupId}`);

    // ── Membership guard (skip for the open 'global' room) ──
    if (groupId && groupId !== 'global') {
      const userData = connectedUsers.get(socket.id);
      const userId = userData && String(userData.uid ?? userData.id ?? userData._id ?? '');
      if (!userId) {
        socket.emit('unauthorized', { message: 'Authentication required to send messages.' });
        return;
      }
      const group = await Group.findOne({ _id: groupId, members: userId });
      if (!group) {
        console.warn(`[!] Blocked message from ${socket.id} (${userId}) to group ${groupId} — not a member`);
        socket.emit('unauthorized', { message: 'Cannot send messages to this group.' });
        return;
      }
    }

    // Store in MongoDB
    try {
      const newMsg = new Message({
        id: encryptedPayload.id,
        senderId: encryptedPayload.sender,
        senderPublicKey: encryptedPayload.senderPublicKey,
        encryptedPayloads: encryptedPayload.encryptedPayloads,
        timestamp: encryptedPayload.timestamp,
        groupId: groupId,
        isMedia: encryptedPayload.isMedia || false,
        mediaUrl: encryptedPayload.mediaUrl || null
      });
      await newMsg.save();
    } catch (err) {
      console.error('[x] Error saving message:', err);
    }

    // The server only routes the data. It cannot read the payload.
    if (groupId) {
       io.to(groupId).emit('receive_message', encryptedPayload);
    }
  });

  // Typing Indicators
  socket.on('typing_started', ({ groupId, nickname, uid }) => {
    if (groupId) {
      socket.to(groupId).emit('user_typing_update', { uid, nickname, isTyping: true });
    }
  });

  socket.on('typing_stopped', ({ groupId, nickname, uid }) => {
    if (groupId) {
      socket.to(groupId).emit('user_typing_update', { uid, nickname, isTyping: false });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const userData = connectedUsers.get(socket.id);
    if (userData && userData.uid) {
      await User.findByIdAndUpdate(userData.uid, { status: 'offline', lastSeen: new Date() });
      io.emit('user_status_change', { uid: userData.uid, status: 'offline' });
      connectedUsers.delete(socket.id);
      
      // Update room active counts for any rooms they were in
      // Actually finding rooms after disconnect is tricky for memory arrays, but this suffices for UX updates.
      // Broadcast a typing_stopped event globally just in case they disconnected while typing
      io.emit('user_typing_update', { uid: userData.uid, nickname: userData.nickname, isTyping: false });
    }
  });
});

const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`[!] Secure Relay active on port ${PORT}`);
});
