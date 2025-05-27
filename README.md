Though this app was vibe coded, Me and my team conducted much research on what distributed systems archicture to use. This app along with Kubernetes was deployed on my local linux device, and presented as a demo to evaluators, Sir Nabeel and Sir Gul Munir.

Below Readme is generated with GPT 4.1

# Distributed CLI Chat Application

A distributed chat platform accessible entirely from the command line.

## Microservices

- **Message Service**: Manages sending and receiving messages.
- **Presence Service**: Tracks which users are online.
- **Room Service**: Creates and manages chat rooms.
- **Notification Service**: Notifies users of incoming messages.

## Commands

- `chat-cli join <room>` → Join a distributed chat room.
- `chat-cli send <username> <message>` → Send a message to a user.
- `chat-cli list` → List all available rooms and users.

## Setup and Installation

### Local Development

1. Clone the repository
2. Run `docker-compose up` to start all services
3. Install the CLI tool: `npm install -g ./cli`

### Cloud Deployment

Kubernetes manifests are provided in the `k8s` directory.

## Technology Stack

- Node.js for microservices
- Redis for pub/sub messaging
- Docker for containerization
- Kubernetes for orchestration 
