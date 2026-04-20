'use strict';

const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const limits = require('./config/limits');
const { getRedisClient, closeRedis } = require('./services/redis');
const { closePool, testConnection } = require('./services/database');
const { initSocket, shutdownSocket } = require('./socket');

// ============================================================
// index.js — Точка входа Pixel Wars
// Express + Helmet + Rate Limit + Socket.io + все API routes
// ============================================================

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// --- Безопасность ---
app.use(helmet({
  contentSecurityPolicy: false, // Отключаем для Turnstile и canvas
  crossOriginEmbedderPolicy: false,
}));

// --- CORS ---
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
app.use(cors({
  origin: [FRONTEND_URL, 'https://pixelwars.yourdomain.com'],
  credentials: true,
}));

// --- Trust proxy (Cloudflare) ---
app.set('trust proxy', 1);

// --- Парсинг JSON ---
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiting: общее API ---
const apiLimiter = rateLimit({
  windowMs: limits.RATE_LIMIT_API.windowMs,
  max: limits.RATE_LIMIT_API.max,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Извлекаем реальный IP из Cloudflare заголовка
    return req.headers['cf-connecting-ip'] || req.ip;
  },
});
app.use('/api/', apiLimiter);

// --- Rate Limiting: авторизация (строже) ---
const authLimiter = rateLimit({
  windowMs: limits.RATE_LIMIT_AUTH.windowMs,
  max: limits.RATE_LIMIT_AUTH.max,
  message: { error: 'Слишком много попыток авторизации.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['cf-connecting-ip'] || req.ip;
  },
});
app.use('/api/auth/', authLimiter);

// --- Статические файлы ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/clans', require('./routes/clans'));
app.use('/api/shop', require('./routes/shop'));

// --- Server Status ---
app.get('/api/server/status', (req, res) => {
  // Получаем данные из OnlineManager (через socket.js)
  const { getIO } = require('./socket');
  // Возвращаем базовую информацию; io доступен после initSocket
  res.json({
    online: 0,
    maxOnline: limits.MAX_ONLINE_PLAYERS,
    spectators: 0,
    isFull: false,
    estimatedQueue: 0,
  });
});

// --- Health Check ---
const startTime = Date.now();
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
  });
});

// --- Spectator page ---
app.get('/spectator', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'spectator.html'));
});

// --- 404 ---
app.use((req, res) => {
  res.status(404).json({ error: 'Не найдено' });
});

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error(`[Express] Ошибка: ${err.message}`);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

async function start() {
  console.log('='.repeat(50));
  console.log('  PIXEL WARS — Запуск сервера');
  console.log('='.repeat(50));

  // 1. Проверяем подключение к PostgreSQL
  console.log('\n[Startup] Подключение к PostgreSQL...');
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[Startup] ФАТАЛЬНАЯ ОШИБКА: Нет подключения к PostgreSQL. Проверьте DATABASE_URL.');
    process.exit(1);
  }

  // 2. Подключаем Redis
  console.log('[Startup] Подключение к Redis...');
  const redis = getRedisClient();
  redis.on('connect', () => {
    console.log('[Startup] Redis подключён');
  });

  // 3. Запускаем Socket.io
  console.log('[Startup] Запуск Socket.io...');
  initSocket(server);

  // 4. Запускаем HTTP сервер
  server.listen(PORT, () => {
    console.log(`\n[Startup] Сервер запущен на порту ${PORT}`);
    console.log(`[Startup] API: http://localhost:${PORT}/api/health`);
    console.log(`[Startup] Трансляция: http://localhost:${PORT}/spectator`);
    console.log(`[Startup] Лимит игроков: ${limits.MAX_ONLINE_PLAYERS}`);
    console.log(`[Startup] Лимит зрителей: ${limits.MAX_SPECTATORS}`);
    console.log('='.repeat(50));
  });
}

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n[Shutdown] Получен сигнал ${signal}, завершение...`);

  console.log('[Shutdown] Закрытие Socket.io...');
  await shutdownSocket();

  console.log('[Shutdown] Закрытие HTTP сервера...');
  server.close(() => {
    console.log('[Shutdown] HTTP сервер закрыт');
  });

  console.log('[Shutdown] Закрытие PostgreSQL...');
  await closePool();

  console.log('[Shutdown] Закрытие Redis...');
  await closeRedis();

  console.log('[Shutdown] Всё завершено. Пока! 👋');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Необработанные исключения
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Необработанное исключение: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Необработанный Promise rejection: ${reason}`);
});

// Запуск
start().catch((err) => {
  console.error(`[FATAL] Ошибка запуска: ${err.message}`);
  process.exit(1);
});

module.exports = { app, server };
