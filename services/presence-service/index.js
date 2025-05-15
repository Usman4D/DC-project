const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('redis');

const app = express();
const port = process.env.PORT || 3002;

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

// Auto-expire user presence after 30 seconds
const PRESENCE_TTL = 30;

// Routes
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

// Get all online users
app.get('/users/online', async (req, res) => {
  try {
    const users = await redisClient.sMembers('online-users');
    
    // Get additional user info
    const userDetails = [];
    for (const username of users) {
      const lastSeen = await redisClient.get(`user:${username}:last-seen`);
      userDetails.push({
        username,
        lastSeen: parseInt(lastSeen || Date.now())
      });
    }
    
    res.json(userDetails);
  } catch (error) {
    console.error('Error fetching online users:', error);
    res.status(500).json({ error: 'Failed to fetch online users' });
  }
});

// Update user presence
app.post('/users/:username/presence', async (req, res) => {
  try {
    const { username } = req.params;
    const timestamp = Date.now();
    
    // Add user to the set of online users
    await redisClient.sAdd('online-users', username);
    
    // Set user's last seen timestamp
    await redisClient.set(`user:${username}:last-seen`, timestamp);
    
    // Auto-expire after TTL (user will be considered offline)
    await redisClient.expire(`user:${username}:last-seen`, PRESENCE_TTL);
    
    // Publish the presence update
    await redisClient.publish('user-presence', JSON.stringify({
      event: 'user-online',
      data: { username, timestamp }
    }));
    
    res.status(200).json({ status: 'online', timestamp });
  } catch (error) {
    console.error('Error updating user presence:', error);
    res.status(500).json({ error: 'Failed to update user presence' });
  }
});

// User logout/offline
app.delete('/users/:username/presence', async (req, res) => {
  try {
    const { username } = req.params;
    
    // Remove user from the set of online users
    await redisClient.sRem('online-users', username);
    
    // Delete user's last seen timestamp
    await redisClient.del(`user:${username}:last-seen`);
    
    // Publish the offline status
    await redisClient.publish('user-presence', JSON.stringify({
      event: 'user-offline',
      data: { username, timestamp: Date.now() }
    }));
    
    res.status(200).json({ status: 'offline' });
  } catch (error) {
    console.error('Error updating user offline status:', error);
    res.status(500).json({ error: 'Failed to update user offline status' });
  }
});

// Background periodic task to clean up stale presence data
setInterval(async () => {
  try {
    const users = await redisClient.sMembers('online-users');
    
    for (const username of users) {
      const lastSeen = await redisClient.get(`user:${username}:last-seen`);
      
      // If lastSeen doesn't exist or is older than TTL, mark user as offline
      if (!lastSeen || Date.now() - parseInt(lastSeen) > PRESENCE_TTL * 1000) {
        await redisClient.sRem('online-users', username);
        
        // Publish the offline status
        await redisClient.publish('user-presence', JSON.stringify({
          event: 'user-offline',
          data: { username, timestamp: Date.now() }
        }));
      }
    }
  } catch (error) {
    console.error('Error in presence cleanup:', error);
  }
}, 10000); // Run every 10 seconds

// Start the server
app.listen(port, () => {
  console.log(`Presence service running on port ${port}`);
}); 