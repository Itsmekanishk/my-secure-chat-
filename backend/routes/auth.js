const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, password, nickname, color1, color2, sym, avatar, googleUid, email } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!password || typeof password !== 'string' || password.length < 1) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const trimmedUsername = username.trim();
    const trimmedNickname = (nickname && typeof nickname === 'string' ? nickname.trim() : trimmedUsername) || trimmedUsername;

    // Check if user exists by username
    const existingUser = await User.findOne({ username: trimmedUsername });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Optionally check if googleUid is already registered
    if (googleUid) {
      const existingGoogleUser = await User.findOne({ googleUid });
      if (existingGoogleUser) {
        return res.status(400).json({ error: 'Google account already registered. Please login.' });
      }
    }

    const newUser = new User({
      username: trimmedUsername,
      password,
      nickname: trimmedNickname,
      color1: color1 || undefined,
      color2: color2 || undefined,
      sym: sym || undefined,
      avatar: avatar || undefined,
      googleUid: googleUid || undefined,
      email: email != null && email !== '' ? email : undefined
    });

    await newUser.save();
    
    const token = jwt.sign({ userId: newUser._id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.status(201).json({ 
      token, 
      user: { 
        id: String(newUser._id), 
        username: newUser.username, 
        nickname: newUser.nickname,
        color1: newUser.color1,
        color2: newUser.color2,
        sym: newUser.sym,
        avatar: newUser.avatar,
        status: newUser.status
      } 
    });
  } catch (err) {
    console.error('[Register Error]', err);
    if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError' || err.name === 'MongoTimeoutError') {
      return res.status(503).json({ error: 'Database unavailable. Please try again later.' });
    }
    if (err.name === 'ValidationError') {
      const msg = err.message || (err.errors && Object.values(err.errors).map(e => e.message).join(', ')) || 'Validation failed';
      return res.status(400).json({ error: msg });
    }
    if (err.name === 'MongoServerError' && err.code === 11000) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    const isDev = process.env.NODE_ENV !== 'production';
    res.status(500).json({
      error: 'Internal server error',
      ...(isDev && err.message && { detail: err.message })
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await User.findOne({ username }).exec();
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ 
      token, 
      user: { 
        id: String(user._id), 
        username: user.username, 
        nickname: user.nickname,
        color1: user.color1,
        color2: user.color2,
        sym: user.sym,
        avatar: user.avatar,
        status: user.status
      } 
    });
  } catch (err) {
    console.error('[Login Error]', err);
    if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') {
      return res.status(503).json({ error: 'Database unavailable. Please try again later.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Current User
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    console.error('[Auth/Me Error]', err);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Get All Users (for Contacts/Sidebar)
router.get('/users', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET); // verify they are authenticated

    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
