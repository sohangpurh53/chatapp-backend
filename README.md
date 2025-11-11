# Chat App Backend

A Node.js backend for a real-time chat application with Socket.IO, Express, and PostgreSQL.

## Features

- User authentication (register/login/logout)
- Real-time messaging with Socket.IO
- Direct and group chats
- User search functionality
- Online/offline status tracking
- Typing indicators
- Message history
- File sharing support (structure ready)

## Tech Stack

- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **Socket.IO** - Real-time communication
- **PostgreSQL** - Database
- **Sequelize** - ORM
- **JWT** - Authentication
- **bcryptjs** - Password hashing

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Installation

1. **Clone and navigate to backend directory:**
   ```bash
   cd backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up PostgreSQL database:**
   - Create a new PostgreSQL database named `chatapp`
   - Update the database credentials in `.env` file

4. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Update the `.env` file with your configuration:
   ```
   PORT=3000
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=chatapp
   DB_USER=your_postgres_user
   DB_PASSWORD=your_postgres_password
   JWT_SECRET=your_super_secret_jwt_key
   NODE_ENV=development
   ```

5. **Start the server:**
   ```bash
   # Development mode with auto-reload
   npm run dev
   
   # Production mode
   npm start
   ```

The server will start on `http://localhost:3000`

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user
- `GET /api/auth/profile` - Get user profile

### Chat
- `POST /api/chat/create` - Create new chat (direct or group)
- `GET /api/chat/my-chats` - Get user's chats
- `GET /api/chat/:chatId/messages` - Get chat messages
- `GET /api/chat/search/users` - Search users

### Health Check
- `GET /api/health` - Server health status

## Socket.IO Events

### Client to Server
- `join_chat` - Join a chat room
- `leave_chat` - Leave a chat room
- `send_message` - Send a message
- `typing_start` - Start typing indicator
- `typing_stop` - Stop typing indicator
- `message_read` - Mark message as read

### Server to Client
- `new_message` - New message received
- `user_typing` - User typing status
- `user_joined` - User joined chat
- `user_left` - User left chat
- `user_status_changed` - User online/offline status
- `message_read` - Message read confirmation
- `error` - Error messages

## Database Schema

### Users
- id (UUID, Primary Key)
- username (String, Unique)
- email (String, Unique)
- password (String, Hashed)
- avatar (String, Optional)
- isOnline (Boolean)
- lastSeen (DateTime)

### Chats
- id (UUID, Primary Key)
- name (String, Optional - null for direct chats)
- isGroup (Boolean)
- avatar (String, Optional)
- description (Text, Optional)
- createdBy (UUID, Foreign Key)

### Messages
- id (UUID, Primary Key)
- content (Text)
- messageType (Enum: text, image, file, audio, video)
- fileUrl (String, Optional)
- fileName (String, Optional)
- fileSize (Integer, Optional)
- isEdited (Boolean)
- editedAt (DateTime, Optional)
- senderId (UUID, Foreign Key)
- chatId (UUID, Foreign Key)

### ChatParticipants
- id (UUID, Primary Key)
- userId (UUID, Foreign Key)
- chatId (UUID, Foreign Key)
- role (Enum: admin, member)
- joinedAt (DateTime)
- leftAt (DateTime, Optional)
- isActive (Boolean)

## Development

### Running in Development Mode
```bash
npm run dev
```

This will start the server with nodemon for auto-reloading on file changes.

### Database Migrations
The application uses Sequelize with `sync({ alter: true })` which automatically updates the database schema based on model definitions. For production, consider using proper migrations.

## Production Deployment

1. Set `NODE_ENV=production` in your environment
2. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "chat-backend"
   ```
3. Set up a reverse proxy with Nginx
4. Use environment variables for sensitive configuration
5. Set up proper logging and monitoring

## Security Considerations

- JWT tokens expire in 7 days
- Passwords are hashed with bcrypt
- CORS is configured for cross-origin requests
- Input validation should be added for production use
- Rate limiting should be implemented
- Use HTTPS in production

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the ISC License.