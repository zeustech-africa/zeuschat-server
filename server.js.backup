const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Store active users
const activeUsers = new Map(); // zeusPin -> socket.id

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // User registers with Zeus-PIN
  socket.on('register', async ({ zeusPin, name, email }) => {
    try {
      const result = await pool.query(
        'INSERT INTO users (zeus_pin, name, email) VALUES ($1, $2, $3) ON CONFLICT (zeus_pin) DO UPDATE SET name = $2, email = $3 RETURNING id',
        [zeusPin, name, email]
      );
      activeUsers.set(zeusPin, socket.id);
      socket.emit('registered', { userId: result.rows[0].id });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // User adds contact (sends invite)
  socket.on('addContact', async ({ fromPin, toPin }) => {
    try {
      // Check if toPin exists
      const toUser = await pool.query('SELECT id FROM users WHERE zeus_pin = $1', [toPin]);
      if (toUser.rows.length === 0) {
        socket.emit('error', 'Recipient Zeus-PIN not found');
        return;
      }

      // Create pending invite
      await pool.query(
        'INSERT INTO invites (from_pin, to_pin, status) VALUES ($1, $2, $3)',
        [fromPin, toPin, 'pending']
      );

      // Notify recipient
      const toSocketId = activeUsers.get(toPin);
      if (toSocketId) {
        io.to(toSocketId).emit('inviteReceived', { fromPin, toPin });
      }

      socket.emit('inviteSent', { toPin });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // User accepts invite
  socket.on('acceptInvite', async ({ fromPin, toPin }) => {
    try {
      // Update invite status
      await pool.query(
        'UPDATE invites SET status = $1 WHERE from_pin = $2 AND to_pin = $3',
        ['accepted', fromPin, toPin]
      );

      // Create friendship record
      await pool.query(
        'INSERT INTO friendships (user1_pin, user2_pin) VALUES ($1, $2)',
        [fromPin, toPin]
      );

      // Notify both users
      const fromSocketId = activeUsers.get(fromPin);
      const toSocketId = activeUsers.get(toPin);
      if (fromSocketId) io.to(fromSocketId).emit('friendAdded', { toPin });
      if (toSocketId) io.to(toSocketId).emit('friendAdded', { fromPin });

      socket.emit('inviteAccepted', { fromPin, toPin });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // Send message
  socket.on('sendMessage', async ({ fromPin, toPin, message, ttl }) => {
    try {
      // Check if friendship exists
      const friendship = await pool.query(
        'SELECT * FROM friendships WHERE (user1_pin = $1 AND user2_pin = $2) OR (user1_pin = $2 AND user2_pin = $1)',
        [fromPin, toPin]
      );
      if (friendship.rows.length === 0) {
        socket.emit('error', 'You must be friends to send messages');
        return;
      }

      // Save message
      await pool.query(
        'INSERT INTO messages (from_pin, to_pin, content, ttl, created_at) VALUES ($1, $2, $3, $4, NOW())',
        [fromPin, toPin, message, ttl]
      );

      // Deliver to recipient
      const toSocketId = activeUsers.get(toPin);
      if (toSocketId) {
        io.to(toSocketId).emit('messageReceived', {
          fromPin,
          message,
          ttl
        });
      }

      socket.emit('messageSent', { toPin, message });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('disconnect', () => {
    // Remove from active users
    for (let [pin, id] of activeUsers.entries()) {
      if (id === socket.id) {
        activeUsers.delete(pin);
        break;
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(process.env.PORT, () => {
  console.log(`🚀 ZeusChat Server running on port ${process.env.PORT}`);
});
