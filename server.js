const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('../zeuschat'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Store active users
const activeUsers = new Map(); // zeusPin -> socket.id

// Generate unique Zeus-PIN
function generateZeusPIN() {
  const num = Math.floor(1000 + Math.random() * 9000);
  const num2 = Math.floor(1000 + Math.random() * 9000);
  return `ZT-${num}-${num2}`;
}

// Send OTP via SendGrid (simulated)
async function sendOTP(email, otp) {
  console.log(`📧 Sending OTP ${otp} to ${email}`);
  // In real app: use SendGrid API
  return true;
}

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // User registers with email/phone → gets OTP
  socket.on('requestOTP', async ({ email }) => {
    try {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await sendOTP(email, otp);
      
      // Store OTP temporarily (10 min expiry)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await pool.query(
        'INSERT INTO otp_requests (email, otp, expires_at) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET otp = $2, expires_at = $3',
        [email, otp, expiresAt]
      );

      socket.emit('otpSent', { email });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // User verifies OTP
  socket.on('verifyOTP', async ({ email, otp }) => {
    try {
      const result = await pool.query(
        'SELECT * FROM otp_requests WHERE email = $1 AND otp = $2 AND expires_at > NOW()',
        [email, otp]
      );

      if (result.rows.length === 0) {
        socket.emit('otpError', 'Invalid or expired OTP');
        return;
      }

      // Create user & generate Zeus-PIN
      const zeusPin = generateZeusPIN();
      const userResult = await pool.query(
        'INSERT INTO users (zeus_pin, email, verified_at) VALUES ($1, $2, NOW()) ON CONFLICT (email) DO UPDATE SET zeus_pin = $1, verified_at = NOW() RETURNING *',
        [zeusPin, email]
      );

      // Clean up OTP
      await pool.query('DELETE FROM otp_requests WHERE email = $1', [email]);

      socket.emit('otpVerified', { user: userResult.rows[0] });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // User registers with Zeus-PIN
  socket.on('register', async ({ zeusPin, name, about }) => {
    try {
      const result = await pool.query(
        'UPDATE users SET name = $2, about = $3 WHERE zeus_pin = $1 RETURNING *',
        [zeusPin, name, about]
      );
      activeUsers.set(zeusPin, socket.id);
      socket.emit('registered', { user: result.rows[0] });
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
        'INSERT INTO invites (from_pin, to_pin, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
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
        'INSERT INTO friendships (user1_pin, user2_pin) VALUES ($1, $2) ON CONFLICT DO NOTHING',
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
      const msgResult = await pool.query(
        'INSERT INTO messages (from_pin, to_pin, content, ttl, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [fromPin, toPin, message, ttl]
      );

      // Deliver to recipient
      const toSocketId = activeUsers.get(toPin);
      if (toSocketId) {
        io.to(toSocketId).emit('messageReceived', {
          fromPin,
          message,
          ttl,
          messageId: msgResult.rows[0].id
        });
      }

      socket.emit('messageSent', { toPin, message });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('disconnect', () => {
    for (let [pin, id] of activeUsers.entries()) {
      if (id === socket.id) {
        activeUsers.delete(pin);
        break;
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/../zeuschat/index.html');
});

app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/../zeuschat/login.html');
});

app.get('/otp', (req, res) => {
  res.sendFile(__dirname + '/../zeuschat/otp.html');
});

app.get('/profile', (req, res) => {
  res.sendFile(__dirname + '/../zeuschat/profile.html');
});

app.get('/chat', (req, res) => {
  res.sendFile(__dirname + '/../zeuschat/chat.html');
});

app.get('/settings', (req, res) => {
  res.sendFile(__dirname + '/../zeuschat/settings.html');
});

server.listen(process.env.PORT, () => {
  console.log(`🚀 ZeusChat 1.0 Server running on port ${process.env.PORT}`);
  console.log(`🌐 Live at: https://zeuschat-server.onrender.com`);
});
