const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// Хранилище комнат
const rooms = new Map();

// Хранилище игр
const games = new Map();

io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);
  console.log('📍 IP адрес клиента:', socket.handshake.address);
  console.log('📍 IP адрес клиента:', socket.handshake.address);
  console.log('🌐 Headers:', socket.handshake.headers);

  // Проверка существования комнаты
  socket.on('check-room', ({ roomId }, callback) => {
    console.log(`🔍 Проверка комнаты ${roomId} от ${socket.id}`);
    
    if (!callback || typeof callback !== 'function') {
      console.error('❌ Callback не предоставлен для check-room');
      return;
    }
    
    try {
      const room = rooms.get(roomId);
      const game = games.get(roomId);
      
      if (room) {
        console.log(`✅ Комната ${roomId} найдена, участников: ${room.participants.length}/${room.maxParticipants}`);
        callback({ exists: true, type: 'room', maxParticipants: room.maxParticipants });
      } else if (game) {
        console.log(`✅ Игра ${roomId} найдена`);
        callback({ exists: true, type: 'game', playerCount: game.playerCount, roles: game.roles });
      } else {
        console.log(`❌ Комната/игра ${roomId} не найдена`);
        callback({ exists: false });
      }
    } catch (error) {
      console.error('❌ Ошибка при проверке комнаты:', error);
      callback({ exists: false });
    }
  });

  // Создание комнаты с параметрами
  socket.on('create-room', ({ roomId, maxParticipants }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        participants: [],
        maxParticipants: maxParticipants || 14,
        type: 'room'
      });
    } else {
      const room = rooms.get(roomId);
      room.maxParticipants = maxParticipants || room.maxParticipants;
    }
    console.log(`Комната ${roomId} создана с максимумом ${maxParticipants} участников`);
  });

  // Присоединение к комнате
  socket.on('join-room', ({ roomId, playerName, playerId }) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        participants: [],
        maxParticipants: 14,
        type: 'room'
      });
    }

    const room = rooms.get(roomId);
    // Проверяем по socketId, чтобы не добавлять дубликаты
    const existingParticipant = room.participants.find(p => p.socketId === socket.id);
    
    if (!existingParticipant && room.participants.length < room.maxParticipants) {
      // Генерируем уникальное имя для участника
      const participantNumber = room.participants.length + 1;
      const participantName = participantNumber === 1 ? 'Участник 1' : `Участник ${participantNumber}`;
      
      const participant = {
        id: playerId || Date.now(), // Используем переданный ID или генерируем новый
        name: participantName, // Используем сгенерированное имя вместо переданного
        socketId: socket.id
      };
      room.participants.push(participant);
      
      console.log(`Игрок ${playerName} присоединился к комнате ${roomId}. Всего участников: ${room.participants.length}`);
      console.log('Список участников:', room.participants.map(p => `${p.name} (${p.id})`));
      
      // Отправляем обновленный список всем в комнате (включая нового участника)
      const updateData = {
        participants: room.participants,
        roomId: roomId,
        maxParticipants: room.maxParticipants
      };
      
      console.log(`Отправка обновления комнаты ${roomId} всем участникам (${room.participants.length} чел.)`);
      io.to(roomId).emit('room-updated', updateData);
      
      // Уведомляем о новом участнике для WebRTC
      socket.to(roomId).emit('webrtc-new-peer', { socketId: socket.id, roomId });
    } else if (existingParticipant) {
      // Если уже есть, просто отправляем текущий список этому сокету
      socket.emit('room-updated', {
        participants: room.participants,
        roomId: roomId,
        maxParticipants: room.maxParticipants
      });
      console.log(`Игрок ${playerName} уже в комнате ${roomId}, отправлен текущий список`);
    } else {
      // Комната переполнена
      socket.emit('room-error', {
        message: 'Комната переполнена',
        roomId: roomId
      });
      console.log(`Попытка присоединиться к переполненной комнате ${roomId}`);
    }
  });

  // WebRTC сигналинг события
  socket.on('webrtc-offer', ({ offer, toSocketId, roomId }) => {
    console.log(`📹 WebRTC offer от ${socket.id} к ${toSocketId}`);
    socket.to(toSocketId).emit('webrtc-offer', {
      offer,
      fromSocketId: socket.id,
      roomId
    });
  });

  socket.on('webrtc-answer', ({ answer, toSocketId, roomId }) => {
    console.log(`📹 WebRTC answer от ${socket.id} к ${toSocketId}`);
    socket.to(toSocketId).emit('webrtc-answer', {
      answer,
      fromSocketId: socket.id,
      roomId
    });
  });

  socket.on('webrtc-ice-candidate', ({ candidate, toSocketId, roomId }) => {
    socket.to(toSocketId).emit('webrtc-ice-candidate', {
      candidate,
      fromSocketId: socket.id,
      roomId
    });
  });

  socket.on('webrtc-new-peer', ({ socketId, roomId }) => {
    console.log(`📹 Новый WebRTC peer: ${socketId} в комнате ${roomId}`);
    socket.to(roomId).emit('webrtc-new-peer', { socketId });
  });

  // Присоединение к игре
  socket.on('join-game', ({ gameId, playerName, playerId, playerCount, roles }) => {
    socket.join(gameId);
    
    if (!games.has(gameId)) {
      games.set(gameId, {
        id: gameId,
        players: [],
        playerCount: playerCount,
        roles: roles,
        selectedHost: null,
        type: 'game'
      });
    }

    const game = games.get(gameId);
    const existingPlayer = game.players.find(p => p.id === playerId);
    
    if (!existingPlayer && game.players.length < game.playerCount) {
      const player = {
        id: playerId,
        name: playerName,
        socketId: socket.id
      };
      game.players.push(player);
      
      // Отправляем обновленный список всем в игре
      io.to(gameId).emit('game-updated', {
        players: game.players,
        playerCount: game.playerCount,
        roles: game.roles,
        selectedHost: game.selectedHost,
        gameId: gameId
      });
      
      console.log(`Игрок ${playerName} присоединился к игре ${gameId}`);
    }
  });

  // Выбор ведущего
  socket.on('select-host', ({ gameId, hostId }) => {
    const game = games.get(gameId);
    if (game) {
      game.selectedHost = hostId;
      io.to(gameId).emit('host-selected', {
        selectedHost: hostId,
        gameId: gameId
      });
      console.log(`Ведущий выбран в игре ${gameId}: ${hostId}`);
    }
  });

  // Начало игры
  socket.on('start-game', ({ gameId, players, playerCount, selectedHost, roles }) => {
    const game = games.get(gameId);
    if (game) {
      io.to(gameId).emit('game-started', {
        players: players,
        playerCount: playerCount,
        selectedHost: selectedHost,
        roles: roles,
        gameId: gameId
      });
      console.log(`Игра ${gameId} началась`);
    }
  });

  // Вход в комнату
  socket.on('enter-room', ({ roomId, participants, maxParticipants }) => {
    io.to(roomId).emit('room-entered', {
      participants: participants,
      maxParticipants: maxParticipants,
      roomId: roomId
    });
    console.log(`Вход в комнату ${roomId}`);
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
    
    // Удаляем из комнат
    rooms.forEach((room, roomId) => {
      const index = room.participants.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        room.participants.splice(index, 1);
        io.to(roomId).emit('room-updated', {
          participants: room.participants,
          roomId: roomId
        });
      }
    });

    // Удаляем из игр
    games.forEach((game, gameId) => {
      const index = game.players.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        game.players.splice(index, 1);
        io.to(gameId).emit('game-updated', {
          players: game.players,
          playerCount: game.playerCount,
          roles: game.roles,
          selectedHost: game.selectedHost,
          gameId: gameId
        });
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Получаем все сетевые интерфейсы для отладки (только в development)
if (NODE_ENV === 'development') {
  const networkInterfaces = os.networkInterfaces();
  console.log('📡 Доступные сетевые интерфейсы:');
  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  - ${interfaceName}: ${iface.address}`);
      }
    });
  });

  // Определяем IP адрес для подключения
  let serverIP = 'localhost';
  const interfaces = os.networkInterfaces();
  for (const interfaceName in interfaces) {
    const ifaces = interfaces[interfaceName];
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        serverIP = iface.address;
        break;
      }
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (development)`);
    console.log(`📱 Подключись к: http://localhost:${PORT}`);
    if (serverIP !== 'localhost') {
      console.log(`🌐 Для телефонов используй IP: http://${serverIP}:${PORT}`);
    }
    console.log(`⚠️ Если не подключается, проверь файрвол Windows - разреши порт ${PORT}`);
    console.log(`🔍 Ожидание подключений...`);
  });
} else {
  // Production - слушаем на всех интерфейсах
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (production)`);
    console.log(`🌐 Публичный URL будет доступен после деплоя`);
    console.log(`🔍 Ожидание подключений...`);
  });
}

