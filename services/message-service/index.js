const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3001;

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
})();

// Routes
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

// Get messages for a room
app.get('/api/messages/:room', async (req, res) => {
  try {
    const { room } = req.params;
    const messages = await redisClient.lRange(`room:${room}:messages`, 0, -1);
    
    res.json(messages.map(msg => JSON.parse(msg)));
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a message to a room
app.post('/api/messages/:room', async (req, res) => {
  try {
    const { room } = req.params;
    const { sender, content } = req.body;
    
    if (!sender || !content) {
      return res.status(400).json({ error: 'Sender and content are required' });
    }
    
    const message = {
      id: uuidv4(),
      sender,
      content,
      room,
      timestamp: Date.now()
    };
    
    // Store the message
    await redisClient.lPush(`room:${room}:messages`, JSON.stringify(message));
    
    // Trim the list to keep only the latest 100 messages
    await redisClient.lTrim(`room:${room}:messages`, 0, 99);
    
    // Publish the message to the room channel
    await redisClient.publish('chat-messages', JSON.stringify({
      event: 'new-message',
      data: message
    }));
    
    res.status(201).json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Send a direct message to a user
app.post('/api/messages/direct/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { sender, content } = req.body;
    
    if (!sender || !content) {
      return res.status(400).json({ error: 'Sender and content are required' });
    }
    
    const message = {
      id: uuidv4(),
      sender,
      recipient: username,
      content,
      direct: true,
      timestamp: Date.now()
    };
    
    // Store the message in both sender and recipient's direct message lists
    await redisClient.lPush(`user:${sender}:direct:${username}`, JSON.stringify(message));
    await redisClient.lPush(`user:${username}:direct:${sender}`, JSON.stringify(message));
    
    // Trim the lists to keep only the latest 100 messages
    await redisClient.lTrim(`user:${sender}:direct:${username}`, 0, 99);
    await redisClient.lTrim(`user:${username}:direct:${sender}`, 0, 99);
    
    // Publish the direct message
    await redisClient.publish('chat-messages', JSON.stringify({
      event: 'new-direct-message',
      data: message
    }));
    
    res.status(201).json(message);
  } catch (error) {
    console.error('Error sending direct message:', error);
    res.status(500).json({ error: 'Failed to send direct message' });
  }
});

// Get direct messages between two users
app.get('/api/messages/direct/:sender/:recipient', async (req, res) => {
  try {
    const { sender, recipient } = req.params;
    
    const messages = await redisClient.lRange(`user:${sender}:direct:${recipient}`, 0, -1);
    
    res.json(messages.map(msg => JSON.parse(msg)));
  } catch (error) {
    console.error('Error fetching direct messages:', error);
    res.status(500).json({ error: 'Failed to fetch direct messages' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Message service running on port ${port}`);
}); 