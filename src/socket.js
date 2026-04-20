'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const limits = require('./config/limits');
const OnlineManager = require('./services/onlineManager');
const { getRedisClient, getSubscriber, getPublisher } = require('./services/redis');
const { analyzeConnection } = require('./services/botDetection');

// ============================================================
// socket.js — Сервер Socket.io + игровая логика
// Управление подключениями, обработка пикселей, кланов, бустеров
// ============================================================

let io = null;
let onlineManager = null;
let redisClient = null;

// --- Буфер для батч-записи пикселей в PostgreSQL ---
const pixelBatch = [];
let batchTimer = null;

/**
 * Инициализация Socket.io сервера
 * @param {http.Server} httpServer — HTTP сервер Express
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    // ТОЛЬКО WebSocket (не polling) — для производительности
    transports: ['websocket'],
    // Пинг/понг каждые 25 сек, отключение через 60 сек
    pingInterval: 25000,
    pingTimeout: 60000,
    // Максимум подключений
    maxHttpBufferSize: 1e6, // 1MB (для буфера холста)
  });

  redisClient = getRedisClient();
  onlineManager = new OnlineManager(redisClient);
  onlineManager.startCleanup();

  // --- Middleware: антибот + JWT ---
  io.use(async (socket, next) => {
    try {
      const req = socket.request;

      // 1. Антибот-проверка
      const botResult = await analyzeConnection(req, redisClient);
      if (!botResult.allowed) {
        return next(new Error(`Доступ запрещён: ${botResult.reason}`));
      }

      // 2. Проверка JWT-токена
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) {
        return next(new Error('Токен не предоставлен'));
      }

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        return next(new Error('Неверный или истёкший токен'));
      }

      // Сохраняем данные пользователя в socket
      socket.user = decoded; // { userId, telegramId, username }

      next();
    } catch (err) {
      next(err);
    }
  });

  // --- Обработка подключения ---
  io.on('connection', (socket) => {
    const userId = socket.user.userId;
    const username = socket.user.username;
    const ip = socket.request.headers['cf-connecting-ip'] || socket.request.ip || 'unknown';

    console.log(`[Socket] Подключение: ${username} (user: ${userId}, ip: ${ip})`);

    // Попытка подключения как игрок
    const connectResult = onlineManager.tryConnectAsPlayer(userId, socket.id, username);

    if (connectResult.mode === 'duplicate') {
      // Кикаем старую сессию
      const oldSocketId = connectResult.existingSocketId;
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.emit('error:kicked', { reason: 'duplicate_login', message: 'Вы зашли с другого устройства' });
        oldSocket.disconnect(true);
      }
      // Переподключаем нового как игрока
      const retryResult = onlineManager.tryConnectAsPlayer(userId, socket.id, username);
      _handleConnection(socket, retryResult);
    } else if (connectResult.mode === 'denied') {
      socket.emit('access:denied', {
        reason: connectResult.reason,
        message: 'Сервер перегружен. Попробуйте позже.',
      });
      socket.disconnect(true);
    } else {
      _handleConnection(socket, connectResult);
    }

    // Обновление активности
    socket.on('client:ping', () => {
      onlineManager.updateActivity(socket.id);
      socket.emit('server:pong', {
        online: onlineManager.getStatus().online,
        spectators: onlineManager.getStatus().spectators,
        timestamp: Date.now(),
      });
    });

    // --- Обработчики событий ---

    // Ставка пикселя
    socket.on('pixel:place', async (data) => {
      await _placePixel(socket, data);
    });

    // Запрос профиля
    socket.on('profile:get', async () => {
      await _getUserProfile(socket);
    });

    // Запрос статуса сервера
    socket.on('server:status', () => {
      socket.emit('server:status', onlineManager.getStatus());
    });

    // Покупка бустера
    socket.on('booster:buy', async () => {
      await _buyBooster(socket);
    });

    // Создание клана
    socket.on('clan:create', async (data) => {
      await _createClan(socket, data);
    });

    // Лидерборд кланов
    socket.on('clan:leaderboard', async () => {
      await _getClanLeaderboard(socket);
    });

    // Повторная синхронизация холста
    socket.on('canvas:resync', async () => {
      await _sendCanvasInit(socket);
    });

    // Отключение
    socket.on('disconnect', (reason) => {
      onlineManager.disconnect(socket.id);
      console.log(`[Socket] Отключение: ${username} (user: ${userId}, причина: ${reason})`);
    });
  });

  // --- Запуск батч-записи пикселей ---
  _startPixelBatch();

  // --- Запуск генерации snapshot для зрителей ---
  _startSnapshotGenerator();

  // --- Pub/Sub для cross-process ---
  _setupPubSub();

  console.log('[Socket] Сервер Socket.io запущен');
}

/**
 * Обработка успешного подключения (игрок или зритель)
 */
function _handleConnection(socket, result) {
  onlineManager.updateActivity(socket.id);

  if (result.mode === 'player') {
    socket.join('players');
    socket.emit('mode:player', {
      mode: 'player',
      online: result.online,
      maxOnline: result.maxOnline,
    });

    // Отправляем полный буфер холста
    _sendCanvasInit(socket);

  } else if (result.mode === 'spectator') {
    socket.join('spectators');
    socket.emit('mode:spectator', {
      mode: 'spectator',
      currentOnline: result.currentOnline,
      maxOnline: result.maxOnline,
      yourPosition: result.yourPosition,
    });

    // Отправляем последний snapshot
    _sendLatestSnapshot(socket);
  }
}

// ============================================================
// ИГРОВЫЕ ФУНКЦИИ (реализации, НЕ заглушки)
// ============================================================

/**
 * Отправить полный буфер холста игроку
 */
async function _sendCanvasInit(socket) {
  try {
    if (!redisClient || redisClient.status !== 'ready') {
      socket.emit('error', { code: 'redis_unavailable', message: 'Сервер перегружен, попробуйте позже' });
      return;
    }

    const buffer = await redisClient.getBuffer(limits.REDIS_KEYS.CANVAS_BUFFER);

    if (buffer && buffer.length > 0) {
      socket.emit('canvas:init', buffer.toString('base64'));
    } else {
      // Если холст пуст — создаём белый буфер 1000x1000 RGB
      console.log('[Socket] Холст пуст, создаю белый буфер...');
      const whiteCanvas = Buffer.alloc(limits.CANVAS_BUFFER_SIZE, 255);
      await redisClient.set(limits.REDIS_KEYS.CANVAS_BUFFER, whiteCanvas);
      socket.emit('canvas:init', whiteCanvas.toString('base64'));
    }
  } catch (err) {
    console.error(`[Socket] Ошибка отправки холста: ${err.message}`);
    socket.emit('error', { code: 'canvas_error', message: 'Ошибка загрузки холста' });
  }
}

/**
 * Отправить последний JPEG snapshot зрителю
 */
async function _sendLatestSnapshot(socket) {
  try {
    if (!redisClient || redisClient.status !== 'ready') return;

    const jpeg = await redisClient.get(limits.REDIS_KEYS.CANVAS_SNAPSHOT_JPEG);
    if (jpeg) {
      socket.emit('spectator:snapshot', { image: `data:image/jpeg;base64,${jpeg}` });
    }
  } catch (err) {
    console.error(`[Socket] Ошибка отправки snapshot: ${err.message}`);
  }
}

/**
 * Ставка пикселя — основная игровая механика
 * 1. Проверка кулдауна (Redis)
 * 2. Запись пикселя в Redis-буфер холста
 * 3. Добавление в батч для PostgreSQL
 * 4. Начисление PC
 * 5. Broadcast нового пикселя всем игрокам
 */
async function _placePixel(socket, data) {
  try {
    const { x, y, color } = data;
    const userId = socket.user.userId;
    const username = socket.user.username;

    // Валидация координат и цвета
    if (typeof x !== 'number' || typeof y !== 'number' ||
        x < 0 || x >= limits.CANVAS_WIDTH || y < 0 || y >= limits.CANVAS_HEIGHT) {
      socket.emit('error', { code: 'invalid_coords', message: 'Неверные координаты' });
      return;
    }

    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      socket.emit('error', { code: 'invalid_color', message: 'Неверный формат цвета (#rrggbb)' });
      return;
    }

    // 1. Проверка кулдауна
    const rateLimitKey = limits.REDIS_KEYS.RATE_LIMIT_PIXEL(userId);
    const currentTTL = await redisClient.pttl(rateLimitKey);

    if (currentTTL > 0) {
      socket.emit('pixel:cooldown', {
        message: `Подождите ${Math.ceil(currentTTL / 1000)} сек перед следующей ставкой`,
        remaining: Math.ceil(currentTTL / 1000),
      });
      return;
    }

    // 2. Проверяем бустер для определения кулдауна
    const boosterActive = await _checkActiveBooster(userId);
    const cooldownMs = boosterActive ? limits.PIXEL_COOLDOWN_BOOSTER_MS : limits.PIXEL_COOLDOWN_MS;
    const coinReward = boosterActive ? limits.PIXEL_COIN_BOOSTER_REWARD : limits.PIXEL_COIN_REWARD;

    // 3. Устанавливаем кулдаун
    await redisClient.set(rateLimitKey, '1', 'PX', cooldownMs);

    // 4. Записываем пиксель в Redis-буфер холста
    // Пиксель = 3 байта (RGB) по смещению (y * width + x) * 3
    const offset = (y * limits.CANVAS_WIDTH + x) * 3;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const pixelBuffer = Buffer.from([r, g, b]);

    await redisClient.setrange(limits.REDIS_KEYS.CANVAS_BUFFER, offset, pixelBuffer);

    // 5. Добавляем в батч для PostgreSQL
    pixelBatch.push({ userId, x, y, color, username, placedAt: new Date() });

    // 6. Начисление PC (асинхронно, не блокируем ответ)
    _addPixelCoins(userId, coinReward, boosterActive).catch((err) => {
      console.error(`[Socket] Ошибка начисления PC: ${err.message}`);
    });

    // 7. Broadcast всем игрокам
    io.to('players').emit('pixel:update', { x, y, color, userId, username });

    // 8. Подтверждение игроку
    socket.emit('pixel:placed', {
      success: true,
      coins: coinReward,
      cooldown: cooldownMs / 1000,
    });

    onlineManager.updateActivity(socket.id);
  } catch (err) {
    console.error(`[Socket] Ошибка ставки пикселя: ${err.message}`);
    socket.emit('error', { code: 'pixel_error', message: 'Ошибка при установке пикселя' });
  }
}

/**
 * Начисление пикселькоинов за ставку пикселя
 * Обновляет баланс в PostgreSQL + записывает транзакцию
 */
async function _addPixelCoins(userId, amount, boosterUsed) {
  try {
    const db = require('./services/database');
    const pool = db.getPool();

    const result = await pool.query(
      'UPDATE users SET pixel_coins = pixel_coins + $1, pixels_placed = pixels_placed + 1 WHERE id = $2 RETURNING pixel_coins, pixels_placed',
      [amount, userId]
    );

    if (result.rows.length > 0) {
      const newBalance = result.rows[0].pixel_coins;

      // Записываем транзакцию
      await pool.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
         VALUES ($1, 'pixel_place', $2, $3, 'PC', $4)`,
        [userId, amount, newBalance, boosterUsed ? 'Пиксель с бустером' : 'Установка пикселя']
      );

      // Обновляем total_pixels клана, если пользователь в клане
      await pool.query(
        `UPDATE clans SET total_pixels = total_pixels + 1
         WHERE id = (SELECT clan_id FROM users WHERE id = $1) AND id IS NOT NULL`,
        [userId]
      );
    }
  } catch (err) {
    console.error(`[Socket] _addPixelCoins: ${err.message}`);
  }
}

/**
 * Получить профиль пользователя (через Socket.io)
 */
async function _getUserProfile(socket) {
  try {
    const userId = socket.user.userId;
    const db = require('./services/database');
    const pool = db.getPool();

    const result = await pool.query(
      `SELECT id, username, first_name, photo_url, pixel_coins, black_coins, pixels_placed,
              clan_id, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      socket.emit('error', { code: 'not_found', message: 'Пользователь не найден' });
      return;
    }

    const user = result.rows[0];

    // Проверяем бустер
    const boosterActive = await _checkActiveBooster(userId);

    socket.emit('profile:data', {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      photo_url: user.photo_url,
      pixel_coins: user.pixel_coins,
      black_coins: user.black_coins,
      pixels_placed: user.pixels_placed,
      booster_active: boosterActive,
    });
  } catch (err) {
    console.error(`[Socket] _getUserProfile: ${err.message}`);
    socket.emit('error', { code: 'profile_error', message: 'Ошибка загрузки профиля' });
  }
}

/**
 * Проверить, активен ли бустер у пользователя
 * @returns {Promise<boolean>}
 */
async function _checkActiveBooster(userId) {
  try {
    if (!redisClient || redisClient.status !== 'ready') return false;

    const boosterTTL = await redisClient.pttl(limits.REDIS_KEYS.ACTIVE_BOOSTER(userId));
    return boosterTTL > 0;
  } catch (err) {
    return false;
  }
}

/**
 * Покупка бустера через Socket.io
 */
async function _buyBooster(socket) {
  try {
    const userId = socket.user.userId;
    const db = require('./services/database');
    const pool = db.getPool();

    // Проверяем баланс BC
    const user = await pool.query('SELECT black_coins FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) {
      socket.emit('error', { code: 'not_found', message: 'Пользователь не найден' });
      return;
    }

    const currentBC = user.rows[0].black_coins;
    if (currentBC < limits.BOOSTER_COST_BC) {
      socket.emit('error', {
        code: 'insufficient_bc',
        message: `Недостаточно блэккоинов. Нужно ${limits.BOOSTER_COST_BC} BC`,
      });
      return;
    }

    // Проверяем, нет ли уже активного бустера
    if (await _checkActiveBooster(userId)) {
      socket.emit('error', { code: 'booster_active', message: 'Бустер уже активен' });
      return;
    }

    // Списываем BC
    const newBC = currentBC - limits.BOOSTER_COST_BC;
    await pool.query('UPDATE users SET black_coins = $1 WHERE id = $2', [newBC, userId]);

    // Записываем транзакцию
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
       VALUES ($1, 'booster_buy', $2, $3, 'BC', 'Покупка бустера')`,
      [userId, -limits.BOOSTER_COST_BC, newBC]
    );

    // Устанавливаем бустер в Redis
    await redisClient.set(
      limits.REDIS_KEYS.ACTIVE_BOOSTER(userId),
      'active',
      'PX',
      limits.BOOSTER_DURATION_S * 1000
    );

    socket.emit('booster:activated', {
      duration: limits.BOOSTER_DURATION_S,
      cooldown: limits.PIXEL_COOLDOWN_BOOSTER_MS / 1000,
    });

    console.log(`[Socket] Бустер активирован для пользователя ${userId}`);
  } catch (err) {
    console.error(`[Socket] _buyBooster: ${err.message}`);
    socket.emit('error', { code: 'booster_error', message: 'Ошибка покупки бустера' });
  }
}

/**
 * Создание клана через Socket.io
 */
async function _createClan(socket, data) {
  try {
    const { name, tag } = data;
    const userId = socket.user.userId;

    if (!name || !tag) {
      socket.emit('error', { code: 'validation', message: 'Название и тег клана обязательны' });
      return;
    }

    if (tag.length < limits.CLAN_TAG_MIN_LENGTH || tag.length > limits.CLAN_TAG_MAX_LENGTH) {
      socket.emit('error', { code: 'validation', message: `Тег клана: ${limits.CLAN_TAG_MIN_LENGTH}-${limits.CLAN_TAG_MAX_LENGTH} символов` });
      return;
    }

    const db = require('./services/database');
    const pool = db.getPool();

    // Проверяем, есть ли уже клан
    const existingUser = await pool.query('SELECT clan_id, pixel_coins FROM users WHERE id = $1', [userId]);
    if (existingUser.rows.length === 0) {
      socket.emit('error', { code: 'not_found', message: 'Пользователь не найден' });
      return;
    }

    if (existingUser.rows[0].clan_id) {
      socket.emit('error', { code: 'already_in_clan', message: 'Вы уже в клане' });
      return;
    }

    if (existingUser.rows[0].pixel_coins < limits.CLAN_CREATE_COST_PC) {
      socket.emit('error', {
        code: 'insufficient_pc',
        message: `Недостаточно PC. Нужно ${limits.CLAN_CREATE_COST_PC}`,
      });
      return;
    }

    // Проверяем уникальность
    const nameExists = await pool.query('SELECT id FROM clans WHERE name = $1', [name]);
    if (nameExists.rows.length > 0) {
      socket.emit('error', { code: 'name_taken', message: 'Клан с таким названием уже существует' });
      return;
    }

    const tagExists = await pool.query('SELECT id FROM clans WHERE tag = $1', [tag]);
    if (tagExists.rows.length > 0) {
      socket.emit('error', { code: 'tag_taken', message: 'Клан с таким тегом уже существует' });
      return;
    }

    // Создаём клан (транзакция)
    await pool.query('BEGIN');
    try {
      const clan = await pool.query(
        `INSERT INTO clans (name, tag, creator_id, member_count, total_pixels, created_at)
         VALUES ($1, $2, $3, 1, 0, NOW()) RETURNING id, name, tag`,
        [name, tag, userId]
      );

      const clanId = clan.rows[0].id;

      await pool.query(
        `INSERT INTO clan_members (clan_id, user_id, role, joined_at) VALUES ($1, $2, 'leader', NOW())`,
        [clanId, userId]
      );

      const newPC = existingUser.rows[0].pixel_coins - limits.CLAN_CREATE_COST_PC;
      await pool.query('UPDATE users SET clan_id = $1, pixel_coins = $2 WHERE id = $3', [clanId, newPC, userId]);

      await pool.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
         VALUES ($1, 'clan_create', $2, $3, 'PC', $4)`,
        [userId, -limits.CLAN_CREATE_COST_PC, newPC, `Клан "${name}"`]
      );

      await pool.query('COMMIT');

      socket.emit('clan:created', {
        success: true,
        clan: { id: clanId, name, tag },
        new_balance_pc: newPC,
      });

      console.log(`[Socket] Клан "${name}" [${tag}] создан пользователем ${userId}`);
    } catch (txErr) {
      await pool.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error(`[Socket] _createClan: ${err.message}`);
    socket.emit('error', { code: 'clan_error', message: 'Ошибка создания клана' });
  }
}

/**
 * Лидерборд кланов (через Socket.io)
 */
async function _getClanLeaderboard(socket) {
  try {
    const db = require('./services/database');
    const pool = db.getPool();

    const result = await pool.query(
      `SELECT id, name, tag, total_pixels, member_count
       FROM clans ORDER BY total_pixels DESC LIMIT 20`
    );

    const leaderboard = result.rows.map((row, i) => ({
      rank: i + 1,
      ...row,
    }));

    socket.emit('clan:leaderboard', leaderboard);
  } catch (err) {
    console.error(`[Socket] _getClanLeaderboard: ${err.message}`);
    socket.emit('error', { code: 'leaderboard_error', message: 'Ошибка загрузки лидерборда' });
  }
}

// ============================================================
// БАТЧ-ЗАПИСЬ ПИКСЕЛЕЙ В POSTGRESQL
// ============================================================

/**
 * Запуск периодической батч-записи
 * Каждые PIXEL_BATCH_INTERVAL_MS пишем накопленные пиксели в PostgreSQL
 */
function _startPixelBatch() {
  batchTimer = setInterval(async () => {
    if (pixelBatch.length === 0) return;

    // Отрезаем батч для записи
    const batch = pixelBatch.splice(0, limits.PIXEL_BATCH_MAX_SIZE);

    try {
      const db = require('./services/database');
      const pool = db.getPool();

      // Батч INSERT — один запрос вместо N
      const values = batch.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
      const params = batch.flatMap((p) => [p.userId, p.x, p.y, p.color]);

      await pool.query(
        `INSERT INTO pixels (user_id, x, y, color, placed_at) SELECT v.* FROM (VALUES ${values}) AS v(user_id, x, y, color) JOIN (SELECT NOW() AS ts) t ON TRUE`,
        params
      );

      if (batch.length > 0) {
        console.log(`[Socket] Батч: записано ${batch.length} пикселей в PostgreSQL`);
      }
    } catch (err) {
      console.error(`[Socket] Ошибка батч-записи пикселей: ${err.message}`);
    }
  }, limits.PIXEL_BATCH_INTERVAL_MS);

  console.log(`[Socket] Батч-запись пикселей запущена (каждые ${limits.PIXEL_BATCH_INTERVAL_MS / 1000}с)`);
}

// ============================================================
// SNAPSHOT ГЕНЕРАТОР (JPEG каждые 5 сек для зрителей)
// ============================================================

function _startSnapshotGenerator() {
  const interval = setInterval(async () => {
    try {
      if (!redisClient || redisClient.status !== 'ready') return;

      // Получаем буфер холста
      const buffer = await redisClient.getBuffer(limits.REDIS_KEYS.CANVAS_BUFFER);
      if (!buffer || buffer.length === 0) return;

      // Конвертируем RGB буфер в JPEG через sharp
      const rawRGB = {
        data: buffer,
        width: limits.CANVAS_WIDTH,
        height: limits.CANVAS_HEIGHT,
        channels: 3,
      };

      const jpegBuffer = await sharp(rawRGB.data, {
        raw: { width: rawRGB.width, height: rawRGB.height, channels: rawRGB.channels },
      })
        .jpeg({ quality: 60, mozjpeg: false })
        .toBuffer();

      // Сохраняем snapshot в Redis
      await redisClient.set(
        limits.REDIS_KEYS.CANVAS_SNAPSHOT_JPEG,
        jpegBuffer.toString('base64'),
        'PX',
        15000 // TTL 15 сек (3 x интервал)
      );

      // Отправляем зрителям
      io.to('spectators').emit('spectator:snapshot', {
        image: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`,
      });
    } catch (err) {
      console.error(`[Socket] Ошибка генерации snapshot: ${err.message}`);
    }
  }, limits.SNAPSHOT_INTERVAL_MS);

  console.log(`[Socket] Snapshot генератор запущен (каждые ${limits.SNAPSHOT_INTERVAL_MS / 1000}с)`);

  // Не храним ссылку на interval — он работает всё время жизни сервера
}

// ============================================================
// PUB/SUB для cross-process (если запущено несколько инстансов)
// ============================================================

function _setupPubSub() {
  try {
    const subscriber = getSubscriber();
    const publisher = getPublisher();

    // Подписываемся на обновления пикселей
    subscriber.subscribe('pixel:updates');

    subscriber.on('message', (channel, message) => {
      if (channel === 'pixel:updates' && io) {
        const data = JSON.parse(message);
        io.to('players').emit('pixel:update', data);
      }
    });

    console.log('[Socket] Pub/Sub настроен для cross-process');
  } catch (err) {
    console.warn(`[Socket] Pub/Sub не настроен: ${err.message}`);
  }
}

/**
 * Очистка при shutdown
 */
async function shutdownSocket() {
  if (batchTimer) clearInterval(batchTimer);
  if (onlineManager) onlineManager.stopCleanup();
  if (io) io.close();
}

/**
 * Получить экземпляр io (для использования в routes)
 */
function getIO() {
  return io;
}

module.exports = {
  initSocket,
  shutdownSocket,
  getIO,
};
