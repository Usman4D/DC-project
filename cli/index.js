#!/usr/bin/env node

const { program } = require('commander');
const axios = require('axios');
const WebSocket = require('ws');
const chalk = require('chalk');
const inquirer = require('inquirer');
const moment = require('moment');
const ora = require('ora');
const readline = require('readline');

// Configuration
const config = {
  host: process.env.CHAT_HOST || 'localhost',
  messageServicePort: process.env.MESSAGE_SERVICE_PORT || 3001,
  presenceServicePort: process.env.PRESENCE_SERVICE_PORT || 3002,
  roomServicePort: process.env.ROOM_SERVICE_PORT || 3003,
  notificationServicePort: process.env.NOTIFICATION_SERVICE_PORT || 3004,
  useIngress: process.env.CHAT_HOST && process.env.CHAT_HOST !== 'localhost',
  apiBasePath: process.env.CHAT_API_BASE_PATH || '/api',
  wsPath: process.env.CHAT_WS_PATH || '/ws'
};

// Determine if we are targeting an Ingress or direct host/port
const useIngress = config.host !== 'localhost';

// Shared state
let username = process.env.USER || 'user-' + Math.floor(Math.random() * 1000);
let currentRoom = null;
let ws = null;

// Create API clients
const messageApi = axios.create({
  baseURL: useIngress ? `http://${config.host}${config.apiBasePath}/messages` : `http://${config.host}:${config.messageServicePort}`
});

const presenceApi = axios.create({
  baseURL: useIngress ? `http://${config.host}${config.apiBasePath}/presence` : `http://${config.host}:${config.presenceServicePort}`
});

const roomApi = axios.create({
  baseURL: useIngress ? `http://${config.host}${config.apiBasePath}/rooms` : `http://${config.host}:${config.roomServicePort}`
});

const notificationApi = axios.create({
  baseURL: useIngress ? `http://${config.host}/` : `http://${config.host}:${config.notificationServicePort}`
});

// Connect to the notification WebSocket
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const spinner = ora('Connecting to chat server...').start();
    
    const wsUrl = useIngress 
      ? `ws://${config.host}${config.wsPath}` 
      : `ws://${config.host}:${config.notificationServicePort}`;
    ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
      spinner.succeed('Connected to chat server');
      
      // Register user
      ws.send(JSON.stringify({
        type: 'register',
        username
      }));
      
      resolve();
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        switch (message.type) {
          case 'register':
            console.log(chalk.green('✓ Registered as', username));
            break;
            
          case 'message':
            if (currentRoom === message.data.room) {
              const time = moment(message.data.timestamp).format('HH:mm:ss');
              console.log(
                chalk.gray(`[${time}]`),
                chalk.yellow(`${message.data.sender}:`),
                message.data.content
              );
            }
            break;
            
          case 'direct-message':
            const time = moment(message.data.timestamp).format('HH:mm:ss');
            console.log(
              chalk.gray(`[${time}]`),
              chalk.magenta(`${message.data.sender} (DM):`),
              message.data.content
            );
            break;
            
          case 'presence':
            if (message.data.username !== username) {
              if (message.event === 'user-online') {
                console.log(chalk.green(`${message.data.username} is now online`));
              } else if (message.event === 'user-offline') {
                console.log(chalk.red(`${message.data.username} went offline`));
              }
            }
            break;
            
          case 'room':
            if (message.event === 'user-joined' && message.data.room === currentRoom) {
              console.log(chalk.cyan(`${message.data.username} joined the room`));
            } else if (message.event === 'user-left' && message.data.room === currentRoom) {
              console.log(chalk.cyan(`${message.data.username} left the room`));
            } else if (message.event === 'room-created') {
              console.log(chalk.cyan(`New room created: ${message.data.name}`));
            }
            break;
            
          case 'notification':
            console.log(
              chalk.bgMagenta.white(' NOTIFICATION '),
              chalk.magenta(message.data.title),
              message.data.message
            );
            break;
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });
    
    ws.on('error', (error) => {
      spinner.fail('Failed to connect to chat server');
      console.error('WebSocket error:', error);
      reject(error);
    });
    
    ws.on('close', () => {
      console.log(chalk.yellow('Disconnected from chat server'));
    });
  });
}

// Update user presence
async function updatePresence() {
  try {
    await presenceApi.post(`/users/${username}/presence`);
  } catch (error) {
    console.error('Failed to update presence:', error.message);
  }
}

// Set up presence heartbeat
function setupPresenceHeartbeat() {
  // Update presence immediately
  updatePresence();
  
  // Then update every 15 seconds
  return setInterval(updatePresence, 15000);
}

// Command: Join a room
async function joinRoom(roomName) {
  try {
    const spinner = ora(`Joining room ${roomName}...`).start();
    
    // Join the room
    await roomApi.post(`/${roomName}/join`, { username });
    
    // Get recent messages
    const { data: messages } = await messageApi.get(`/${roomName}`);
    
    spinner.succeed(`Joined room: ${roomName}`);
    
    // Show recent messages
    console.log(chalk.bold('\nRecent messages:'));
    messages.slice(-10).forEach(msg => {
      const time = moment(msg.timestamp).format('HH:mm:ss');
      console.log(
        chalk.gray(`[${time}]`),
        chalk.yellow(`${msg.sender}:`),
        msg.content
      );
    });
    
    currentRoom = roomName;
    
    // Enter chat mode
    console.log(chalk.bold('\nChat mode:'), 'Type your message or', chalk.italic('/quit'), 'to exit');
    
    // Set up readline interface for chat input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${username}> `
    });
    
    rl.prompt();
    
    rl.on('line', async (line) => {
      line = line.trim();
      
      if (line === '/quit' || line === '/exit') {
        // Leave the room
        await roomApi.post(`/${roomName}/leave`, { username });
        currentRoom = null;
        rl.close();
        console.log(chalk.yellow(`Left room: ${roomName}`));
        return;
      }
      
      // Skip empty messages
      if (!line) {
        rl.prompt();
        return;
      }
      
      // Send the message
      try {
        await messageApi.post(`/${roomName}`, {
          sender: username,
          content: line
        });
      } catch (error) {
        console.error('Failed to send message:', error.message);
      }
      
      rl.prompt();
    });
  } catch (error) {
    console.error('Failed to join room:', error.message);
  }
}

// Command: Send a direct message
async function sendDirectMessage(recipient, message) {
  try {
    const spinner = ora(`Sending message to ${recipient}...`).start();
    
    await messageApi.post(`/direct/${recipient}`, {
      sender: username,
      content: message
    });
    
    spinner.succeed(`Message sent to ${recipient}`);
  } catch (error) {
    console.error('Failed to send direct message:', error.message);
  }
}

// Command: List rooms and users
async function listRoomsAndUsers() {
  try {
    console.log(chalk.bold('\nAvailable Rooms:'));
    
    // Get all rooms
    const { data: rooms } = await roomApi.get('/');
    
    if (rooms.length === 0) {
      console.log('No rooms available');
    } else {
      rooms.forEach(room => {
        console.log(`- ${room.name} (Created by: ${room.creator})`);
      });
    }
    
    console.log(chalk.bold('\nOnline Users:'));
    
    // Get online users
    const { data: users } = await presenceApi.get('/users/online');
    
    if (users.length === 0) {
      console.log('No users online');
    } else {
      users.forEach(user => {
        const lastSeen = moment(user.lastSeen).fromNow();
        console.log(`- ${user.username} (Last seen: ${lastSeen})`);
      });
    }
  } catch (error) {
    console.error('Failed to list rooms and users:', error.message);
  }
}

// Command: Create a new room
async function createRoom(name, description) {
  try {
    const spinner = ora(`Creating room ${name}...`).start();
    
    await roomApi.post('/', { name, creator: username, description });
    
    spinner.succeed(`Room created: ${name}`);
  } catch (error) {
    console.error('Failed to create room:', error.message);
  }
}

// Set up commands
program
  .version('1.0.0')
  .description('Distributed CLI Chat Application');

program
  .command('join <room>')
  .description('Join a chat room')
  .action(async (room) => {
    try {
      await connectWebSocketIfNeeded();
      const heartbeat = setupPresenceHeartbeat();
      await joinRoom(room);
      clearInterval(heartbeat);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('send <username> <message>')
  .description('Send a direct message to a user')
  .action(async (recipient, message) => {
    try {
      await connectWebSocketIfNeeded();
      const heartbeat = setupPresenceHeartbeat();
      await sendDirectMessage(recipient, message);
      setTimeout(() => {
        clearInterval(heartbeat);
        process.exit(0);
      }, 1000);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all available rooms and online users')
  .action(async () => {
    try {
      await connectWebSocketIfNeeded();
      const heartbeat = setupPresenceHeartbeat();
      await listRoomsAndUsers();
      setTimeout(() => {
        clearInterval(heartbeat);
        process.exit(0);
      }, 1000);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('create <name> [description]')
  .description('Create a new chat room')
  .action(async (name, description) => {
    try {
      await connectWebSocketIfNeeded();
      const heartbeat = setupPresenceHeartbeat();
      await createRoom(name, description || '');
      setTimeout(() => {
        clearInterval(heartbeat);
        process.exit(0);
      }, 1000);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('login <username>')
  .description('Set your username')
  .action((newUsername) => {
    username = newUsername;
    console.log(`Username set to: ${username}`);
  });

// Parse arguments
program.parse(process.argv);

async function connectWebSocketIfNeeded() {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    await connectWebSocket();
  }
} 