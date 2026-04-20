'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { getRedisClient } = require('../services/redis');

// ============================================================
// auth.js — Авторизация через Telegram Login Widget
// Верификация hash через SHA256, выдача JWT-токена
// ============================================================

/**
 * Верификация данных от Telegram Login Widget
 * Алгоритм: SHA256 сортированных "key=value" + HMAC с SHA256(BotToken)
 * Документация: https://core.telegram.org/widgets/login#checking-authorization
 *
 * @param {Object} telegramData - Данные от виджета { id, first_name, username, photo_url, hash, auth_date }
 * @returns {{ valid: boolean, error: string|null }}
 */
function verifyTelegramHash(telegramData) {
  const { hash, ...dataFields } = telegramData;

  if (!hash || !telegramData.id || !telegramData.auth_date) {
    return { valid: false, error: 'Отсутствуют обязательные поля' };
  }

  // Проверка срока действия auth_date (не старше 86400 секунд = 24 часа)
  const authDate = parseInt(telegramData.auth_date, 10);
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400) {
    return { valid: false, error: 'Срок действия авторизации истёк' };
  }

  // Сортируем поля по алфавиту (кроме hash)
  const sortedKeys = Object.keys(dataFields).sort();
  const dataCheckString = sortedKeys
    .map((key) => `${key}=${telegramData[key]}`)
    .join('\n');

  // Вычисляем secret_key = SHA256(BotToken)
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('[Auth] TELEGRAM_BOT_TOKEN не задан в .env');
    return { valid: false, error: 'Ошибка конфигурации сервера' };
  }

  const secretKey = crypto
    .createHash('sha256')
    .update(botToken)
    .digest();

  // Вычисляем hash = HMAC-SHA256(secret_key, data_check_string)
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    console.warn(`[Auth] Неверный hash Telegram (ожидается: ${computedHash}, получен: ${hash})`);
    return { valid: false, error: 'Неверная подпись Telegram' };
  }

  return { valid: true, error: null };
}

/**
 * Генерация JWT-токена для пользователя
 * Срок действия: 7 дней
 */
function generateToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      telegramId: user.telegram_id,
      username: user.username,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/telegram — Вход через Telegram
router.post('/telegram', async (req, res) => {
  try {
    const telegramData = req.body;

    if (!telegramData || typeof telegramData !== 'object') {
      return res.status(400).json({ error: 'Отсутствуют данные от Telegram' });
    }

    // 1. Верифицируем hash
    const verification = verifyTelegramHash(telegramData);
    if (!verification.valid) {
      return res.status(401).json({ error: verification.error });
    }

    const { id: telegramId, first_name, username, photo_url } = telegramData;

    if (!username) {
      return res.status(400).json({ error: 'Telegram username обязателен' });
    }

    // 2. Ищем или создаём пользователя в БД
    // Используем pool напрямую (импорт ниже)
    const db = require('../services/database');
    const pool = db.getPool();

    // Проверяем, существует ли пользователь
    let user = await pool.query(
      'SELECT id, telegram_id, username, first_name, photo_url, pixel_coins, black_coins, pixels_placed, clan_id FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    if (user.rows.length === 0) {
      // Создаём нового пользователя
      user = await pool.query(
        `INSERT INTO users (telegram_id, username, first_name, photo_url, last_login_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, telegram_id, username, first_name, photo_url, pixel_coins, black_coins, pixels_placed, clan_id`,
        [telegramId, username, first_name || '', photo_url || null]
      );
      console.log(`[Auth] Новый пользователь: ${username} (telegram_id: ${telegramId})`);
    } else {
      // Обновляем last_login
      await pool.query(
        'UPDATE users SET last_login_at = NOW(), username = $2, first_name = $3, photo_url = $4 WHERE telegram_id = $1',
        [telegramId, username, first_name || null, photo_url || null]
      );
    }

    const userData = user.rows[0];

    // 3. Сохраняем сессию в Redis
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      await redis.set(
        `session:${userData.id}`,
        JSON.stringify({ userId: userData.id, socketId: null }),
        'PX',
        7 * 24 * 60 * 60 * 1000 // 7 дней TTL
      );
    }

    // 4. Генерируем JWT
    const token = generateToken(userData);

    console.log(`[Auth] Успешный вход: ${username} (user_id: ${userData.id})`);

    res.json({
      token,
      user: {
        id: userData.id,
        telegram_id: userData.telegram_id,
        username: userData.username,
        first_name: userData.first_name,
        photo_url: userData.photo_url,
        pixel_coins: userData.pixel_coins,
        black_coins: userData.black_coins,
        pixels_placed: userData.pixels_placed,
      },
    });
  } catch (err) {
    console.error(`[Auth] Ошибка авторизации: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// POST /api/auth/verify-turnstile — Проверка Cloudflare Turnstile токена
router.post('/verify-turnstile', async (req, res) => {
  try {
    const { turnstileToken } = req.body;

    if (!turnstileToken) {
      return res.status(400).json({ verified: false, error: 'Отсутствует токен Turnstile' });
    }

    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) {
      console.error('[Auth] TURNSTILE_SECRET_KEY не задан');
      return res.status(500).json({ verified: false, error: 'Ошибка конфигурации' });
    }

    // Верификация через API Cloudflare
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: secretKey,
        response: turnstileToken,
      }),
    });

    const result = await response.json();

    if (result.success) {
      res.json({ verified: true });
    } else {
      console.warn(`[Auth] Turnstile не прошёл: ${JSON.stringify(result['error-codes'] || [])}`);
      res.json({ verified: false, error: 'Капча не пройдена' });
    }
  } catch (err) {
    console.error(`[Auth] Ошибка верификации Turnstile: ${err.message}`);
    res.status(500).json({ verified: false, error: 'Ошибка верификации' });
  }
});

module.exports = router;
