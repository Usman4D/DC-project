const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Redis client setup
const redisClient = createClient({
  url: `redis://${process.env.REDIS_HOST || 'localhost'}:6379`
});

// Connect to Redis
(async () => {
  redisClient.on('error', (err) => console.log('Redis Client Error', err));
  await redisClient.connect();
  console.log('Connected to Redis');
  
  // Create default rooms if they don't exist
  const roomCount = await redisClient.sCard('rooms');
  if (roomCount === 0) {
    const defaultRooms = ['general', 'random', 'tech'];
    for (const room of defaultRooms) {
      await createRoom(room, 'System', 'Default room');
    }
    console.log('Created default rooms');
  }
})();

// Helper function to create a room
async function createRoom(name, creator, description) {
  const roomId = uuidv4();
  const room = {
    id: roomId,
    name,
    creator,
    description,
    created: Date.now()
  };
  
  await redisClient.sAdd('rooms', name);
  await redisClient.hSet(`room:${name}`, room);
  
  return room;
}

// Routes
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

// Get all rooms
app.get('/rooms', async (req, res) => {
  try {
    const roomNames = await redisClient.sMembers('rooms');
    
    const rooms = [];
    for (const name of roomNames) {
      const roomData = await redisClient.hGetAll(`room:${name}`);
      if (Object.keys(roomData).length > 0) {
        rooms.push(roomData);
      }
    }
    
    res.json(rooms);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// Get a specific room by name
app.get('/rooms/:name', async (req, res) => {
  try {
    const { name } = req.params;
    
    const roomExists = await redisClient.sIsMember('rooms', name);
    if (!roomExists) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    const room = await redisClient.hGetAll(`room:${name}`);
    
    // Get users in the room
    const users = await redisClient.sMembers(`room:${name}:users`);
    room.users = users;
    
    res.json(room);
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// Create a new room
app.post('/rooms', async (req, res) => {
  try {
    const { name, creator, description } = req.body;
    
    if (!name || !creator) {
      return res.status(400).json({ error: 'Room name and creator are required' });
    }
    
    const roomExists = await redisClient.sIsMember('rooms', name);
    if (roomExists) {
      return res.status(409).json({ error: 'Room already exists' });
    }
    
    const room = await createRoom(name, creator, description || '');
    
    // Publish room creation event
    await redisClient.publish('room-events', JSON.stringify({
      event: 'room-created',
      data: room
    }));
    
    res.status(201).json(room);
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Join a room
app.post('/rooms/:name/join', async (req, res) => {
  try {
    const { name } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    const roomExists = await redisClient.sIsMember('rooms', name);
    if (!roomExists) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Add user to the room
    await redisClient.sAdd(`room:${name}:users`, username);
    
    // Add room to user's joined rooms
    await redisClient.sAdd(`user:${username}:rooms`, name);
    
    // Publish join event
    await redisClient.publish('room-events', JSON.stringify({
      event: 'user-joined',
      data: { room: name, username, timestamp: Date.now() }
    }));
    
    res.status(200).json({ status: 'joined', room: name });
  } catch (error) {
    console.error('Error joining room:', error);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

// Leave a room
app.post('/rooms/:name/leave', async (req, res) => {
  try {
    const { name } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    // Remove user from the room
    await redisClient.sRem(`room:${name}:users`, username);
    
    // Remove room from user's joined rooms
    await redisClient.sRem(`user:${username}:rooms`, name);
    
    // Publish leave event
    await redisClient.publish('room-events', JSON.stringify({
      event: 'user-left',
      data: { room: name, username, timestamp: Date.now() }
    }));
    
    res.status(200).json({ status: 'left', room: name });
  } catch (error) {
    console.error('Error leaving room:', error);
    res.status(500).json({ error: 'Failed to leave room' });
  }
});

// Get rooms joined by a user
app.get('/users/:username/rooms', async (req, res) => {
  try {
    const { username } = req.params;
    
    const roomNames = await redisClient.sMembers(`user:${username}:rooms`);
    
    res.json(roomNames);
  } catch (error) {
    console.error('Error fetching user rooms:', error);
    res.status(500).json({ error: 'Failed to fetch user rooms' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Room service running on port ${port}`);
}); 