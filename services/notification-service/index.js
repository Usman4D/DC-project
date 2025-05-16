const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('redis');

const app = express();
const port = process.env.PORT || 3004;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Redis client setup
const redisClient = createClient({
  url: `redis://${process.env.REDIS_HOST || 'localhost'}:6379`
});

// Map to store websocket connections by username
const connections = new Map();

// Subscribe to Redis channels
const subscriber = redisClient.duplicate();

// Connect Redis clients
async function connectRedis() {
  redisClient.on('error', (err) => console.log('Redis Client Error', err));
  subscriber.on('error', (err) => console.log('Redis Subscriber Error', err));
  
  await redisClient.connect();
  await subscriber.connect();
  
  console.log('Connected to Redis');
  
  // Subscribe to relevant channels
  await subscriber.subscribe('chat-messages', handleChatMessage);
  await subscriber.subscribe('user-presence', handlePresenceUpdate);
  await subscriber.subscribe('room-events', handleRoomEvent);
  
  console.log('Subscribed to Redis channels');
}

connectRedis();

// Handle incoming messages from Redis
async function handleChatMessage(message) {
  try {
    const data = JSON.parse(message);
    
    if (data.event === 'new-message') {
      // Get users in the room
      const roomUsers = await redisClient.sMembers(`room:${data.data.room}:users`);
      
      // Send notification to all users in the room
      for (const user of roomUsers) {
        const conn = connections.get(user);
        if (conn && conn.readyState === WebSocket.OPEN) {
          conn.send(JSON.stringify({
            type: 'message',
            data: data.data
          }));
        }
      }
    } else if (data.event === 'new-direct-message') {
      // Send notification to the recipient
      const recipient = data.data.recipient;
      const conn = connections.get(recipient);
      
      if (conn && conn.readyState === WebSocket.OPEN) {
        conn.send(JSON.stringify({
          type: 'direct-message',
          data: data.data
        }));
      }
    }
  } catch (error) {
    console.error('Error handling chat message:', error);
  }
}

// Handle presence updates
function handlePresenceUpdate(message) {
  try {
    const data = JSON.parse(message);
    
    // Broadcast presence update to all connected clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'presence',
          data: data.data
        }));
      }
    });
  } catch (error) {
    console.error('Error handling presence update:', error);
  }
}

// Handle room events
function handleRoomEvent(message) {
  try {
    const data = JSON.parse(message);
    
    // Broadcast room event to all connected clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'room',
          event: data.event,
          data: data.data
        }));
      }
    });
  } catch (error) {
    console.error('Error handling room event:', error);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('Client connected');
  
  // Authentication/registration
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'register') {
        const { username } = data;
        
        if (username) {
          // Register the connection with the username
          connections.set(username, ws);
          ws.username = username;
          
          console.log(`User ${username} registered`);
          
          // Send confirmation
          ws.send(JSON.stringify({
            type: 'register',
            status: 'success'
          }));
          
          // Update user presence
          redisClient.publish('user-presence', JSON.stringify({
            event: 'user-online',
            data: { username, timestamp: Date.now() }
          }));
        }
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    if (ws.username) {
      console.log(`User ${ws.username} disconnected`);
      
      // Remove the connection
      connections.delete(ws.username);
      
      // Update user presence
      redisClient.publish('user-presence', JSON.stringify({
        event: 'user-offline',
        data: { username: ws.username, timestamp: Date.now() }
      }));
    }
  });
});

// Routes
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

// Custom notification API route
app.post('/api/notifications/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { title, message } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }
    
    const conn = connections.get(username);
    
    if (conn && conn.readyState === WebSocket.OPEN) {
      conn.send(JSON.stringify({
        type: 'notification',
        data: { title, message, timestamp: Date.now() }
      }));
      
      res.status(200).json({ status: 'sent' });
    } else {
      // Store notification for later delivery
      await redisClient.lPush(`user:${username}:notifications`, JSON.stringify({
        title,
        message,
        timestamp: Date.now()
      }));
      
      res.status(202).json({ status: 'queued' });
    }
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Get pending notifications for a user
app.get('/api/notifications/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const notifications = await redisClient.lRange(`user:${username}:notifications`, 0, -1);
    
    // Clear the notifications (optional)
    await redisClient.del(`user:${username}:notifications`);
    
    res.json(notifications.map(n => JSON.parse(n)));
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Start the server
server.listen(port, () => {
  console.log(`Notification service running on port ${port}`);
}); 