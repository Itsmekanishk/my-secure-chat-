const express = require('express');
const jwt = require('jsonwebtoken');
const Group = require('../models/Group');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

router.use(verifyToken);

// Get all groups
router.get('/', async (req, res) => {
  try {
    const groups = await Group.find().sort({ createdAt: 1 });
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Create a new group
router.post('/', async (req, res) => {
  try {
    const { name, members } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name required' });
    
    // Ensure the creator is essentially always a member
    const uniqueMembers = [...new Set([...(members || []), req.userId])];

    const newGroup = new Group({
      name,
      admin: req.userId,
      isGeneral: false,
      members: uniqueMembers
    });
    
    await newGroup.save();
    res.status(201).json(newGroup);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Rename a group
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body;
    const group = await Group.findById(req.params.id);
    
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.isGeneral) return res.status(403).json({ error: 'Cannot modify the General group' });
    if (group.admin.toString() !== req.userId) return res.status(403).json({ error: 'Only the admin can rename this group' });
    
    group.name = name;
    await group.save();
    
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename group' });
  }
});

// Delete a group
router.delete('/:id', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.isGeneral) return res.status(403).json({ error: 'Cannot delete the General group' });
    if (group.admin.toString() !== req.userId) return res.status(403).json({ error: 'Only the admin can delete this group' });

    await group.deleteOne();
    
    res.json({ message: 'Group deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

module.exports = router;
