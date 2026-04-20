'use strict';

// ============================================================
// limits.js — Все серверные лимиты в одном месте
// Центральная конфигурация для игр, зрителей, rate limits, Redis-ключей
// ============================================================

module.exports = {
  // --- Онлайн ---
  MAX_ONLINE_PLAYERS: 65,          // Максимум одновременных игроков
  MAX_SPECTATORS: 200,              // Максимум зрителей трансляции
  INACTIVE_TIMEOUT_MS: 2 * 60 * 1000, // Таймаут неактивности: 2 минуты
  CLEANUP_INTERVAL_MS: 30 * 1000,   // Интервал очистки неактивных: 30 сек

  // --- Холст ---
  CANVAS_WIDTH: 1000,
  CANVAS_HEIGHT: 1000,
  CANVAS_BUFFER_SIZE: 1000 * 1000 * 3, // 3MB (RGB)

  // --- Rate Limits ---
  RATE_LIMIT_API: { windowMs: 60 * 1000, max: 60 },          // 60 запросов/мин на IP
  RATE_LIMIT_AUTH: { windowMs: 15 * 60 * 1000, max: 10 },    // 10 попыток/15 мин
  RATE_LIMIT_WS_HANDSHAKE: 5,                                  // 5 WS handshake/мин на IP

  // --- Кулдаун пикселя ---
  PIXEL_COOLDOWN_MS: 30 * 1000,       // 30 секунд базовый
  PIXEL_COOLDOWN_BOOSTER_MS: 15 * 1000, // 15 секунд с бустером

  // --- Валюты ---
  PIXEL_COIN_REWARD: 1,               // +1 PC за пиксель
  PIXEL_COIN_BOOSTER_REWARD: 2,       // +2 PC с бустером
  EXCHANGE_RATE_PC_TO_BC: 100,        // 100 PC = 1 BC
  CLAN_CREATE_COST_PC: 5000,          // Стоимость создания клана
  BOOSTER_COST_BC: 10,                // Стоимость бустера
  BOOSTER_DURATION_S: 3600,           // Бустер действует 1 час

  // --- Redis-ключи ---
  REDIS_KEYS: {
    CANVAS_BUFFER: 'canvas:pixels_buffer',
    CANVAS_SNAPSHOT_JPEG: 'canvas:snapshot_jpeg',
    RATE_LIMIT_PIXEL: (userId) => `ratelimit:pixel:${userId}`,
    ONLINE_PLAYERS: 'online:players_count',
    ONLINE_SPECTATORS: 'online:spectators_count',
    ACTIVE_BOOSTER: (userId) => `booster:active:${userId}`,
    SESSION: (userId) => `session:${userId}`,
    BOT_BAN: (ip) => `bot:ban:${ip}`,
    BOT_SCORE: (ip) => `bot:score:${ip}`,
  },

  // --- Антибот ---
  BOT_BAN_THRESHOLD: 100,             // Score >= 100 → бан
  BOT_BAN_DURATION_MS: 60 * 60 * 1000, // Бан на 1 час
  BOT_SCORE_TTL_MS: 5 * 60 * 1000,   // TTL score: 5 минут

  // --- Батч запись пикселей ---
  PIXEL_BATCH_INTERVAL_MS: 3000,     // Запись в PostgreSQL каждые 3 сек
  PIXEL_BATCH_MAX_SIZE: 500,         // Макс. пикселей в одном батче

  // --- Snapshot ---
  SNAPSHOT_INTERVAL_MS: 5000,        // JPEG-снимок каждые 5 сек

  // --- Кланы ---
  CLAN_TAG_MIN_LENGTH: 3,
  CLAN_TAG_MAX_LENGTH: 5,
  CLAN_NAME_MAX_LENGTH: 32,
};
