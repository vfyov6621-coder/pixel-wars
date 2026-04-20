'use strict';

const express = require('express');
const router = express.Router();

// ============================================================
// profile.js — Получение профиля пользователя
// JWT-middleware проверяет токен и выставляет req.user
// ============================================================

/**
 * Middleware для проверки JWT-токена
 * Извлекает userId из токена и ищет пользователя в БД
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  const token = authHeader.slice(7);

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, telegramId, username }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Токен истёк' });
    }
    return res.status(401).json({ error: 'Неверный токен' });
  }
}

// GET /api/profile — Данные текущего пользователя
router.get('/', authMiddleware, async (req, res) => {
  try {
    const db = require('../services/database');
    const pool = db.getPool();

    const result = await pool.query(
      `SELECT
        u.id, u.telegram_id, u.username, u.first_name, u.photo_url,
        u.pixel_coins, u.black_coins, u.pixels_placed,
        u.clan_id, u.created_at, u.last_login_at,
        c.name AS clan_name, c.tag AS clan_tag
       FROM users u
       LEFT JOIN clans c ON u.clan_id = c.id
       WHERE u.id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const user = result.rows[0];

    // Проверяем активный бустер в Redis
    let boosterActive = false;
    let boosterExpiresAt = null;
    try {
      const { getRedisClient } = require('../services/redis');
      const redis = getRedisClient();
      const limits = require('../config/limits');
      if (redis && redis.status === 'ready') {
        const boosterTTL = await redis.pttl(limits.REDIS_KEYS.ACTIVE_BOOSTER(user.id));
        if (boosterTTL > 0) {
          boosterActive = true;
          boosterExpiresAt = Date.now() + boosterTTL;
        }
      }
    } catch (e) {
      // Игнорируем ошибки Redis для некритичного поля
    }

    res.json({
      id: user.id,
      telegram_id: user.telegram_id,
      username: user.username,
      first_name: user.first_name,
      photo_url: user.photo_url,
      pixel_coins: user.pixel_coins,
      black_coins: user.black_coins,
      pixels_placed: user.pixels_placed,
      clan: user.clan_id ? {
        id: user.clan_id,
        name: user.clan_name,
        tag: user.clan_tag,
      } : null,
      booster: {
        active: boosterActive,
        expires_at: boosterExpiresAt,
      },
      created_at: user.created_at,
      last_login_at: user.last_login_at,
    });
  } catch (err) {
    console.error(`[Profile] Ошибка получения профиля: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/profile/leaderboard — Топ-20 игроков по пикселям
router.get('/leaderboard', async (req, res) => {
  try {
    const db = require('../services/database');
    const pool = db.getPool();

    const result = await pool.query(
      `SELECT id, username, first_name, pixels_placed, clan_id
       FROM users
       WHERE pixels_placed > 0
       ORDER BY pixels_placed DESC
       LIMIT 20`
    );

    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      username: row.username,
      first_name: row.first_name,
      pixels_placed: row.pixels_placed,
    }));

    res.json(leaderboard);
  } catch (err) {
    console.error(`[Profile] Ошибка лидерборда: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Экспортируем middleware для использования в других роутах
module.exports = router;
module.exports.authMiddleware = authMiddleware;
