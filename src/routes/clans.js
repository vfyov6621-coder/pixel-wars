'use strict';

const express = require('express');
const router = express.Router();
const limits = require('../config/limits');
const { authMiddleware } = require('./profile');

// ============================================================
// clans.js — Управление кланами
// Создание клана, лидерборд кланов, вступление
// ============================================================

// POST /api/clans/create — Создание нового клана
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { name, tag } = req.body;
    const userId = req.user.userId;

    // Валидация
    if (!name || !tag) {
      return res.status(400).json({ error: 'Название и тег клана обязательны' });
    }

    if (name.length > limits.CLAN_NAME_MAX_LENGTH) {
      return res.status(400).json({ error: `Название клана не более ${limits.CLAN_NAME_MAX_LENGTH} символов` });
    }

    if (tag.length < limits.CLAN_TAG_MIN_LENGTH || tag.length > limits.CLAN_TAG_MAX_LENGTH) {
      return res.status(400).json({
        error: `Тег клана от ${limits.CLAN_TAG_MIN_LENGTH} до ${limits.CLAN_TAG_MAX_LENGTH} символов`,
      });
    }

    // Только буквенно-цифровые символы для тега
    if (!/^[a-zA-Z0-9А-Яа-яЁё]+$/.test(tag)) {
      return res.status(400).json({ error: 'Тег может содержать только буквы и цифры' });
    }

    const db = require('../services/database');
    const pool = db.getPool();

    // Проверяем, есть ли у пользователя уже клан
    const existingUser = await pool.query(
      'SELECT clan_id FROM users WHERE id = $1',
      [userId]
    );

    if (existingUser.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    if (existingUser.rows[0].clan_id) {
      return res.status(400).json({ error: 'Вы уже состоите в клане. Сначала покиньте текущий клан.' });
    }

    // Проверяем, есть ли клан с таким названием или тегом
    const nameExists = await pool.query('SELECT id FROM clans WHERE name = $1', [name]);
    if (nameExists.rows.length > 0) {
      return res.status(400).json({ error: 'Клан с таким названием уже существует' });
    }

    const tagExists = await pool.query('SELECT id FROM clans WHERE tag = $1', [tag]);
    if (tagExists.rows.length > 0) {
      return res.status(400).json({ error: 'Клан с таким тегом уже существует' });
    }

    // Проверяем баланс пикселькоинов
    const userBalance = await pool.query(
      'SELECT pixel_coins FROM users WHERE id = $1',
      [userId]
    );

    if (userBalance.rows[0].pixel_coins < limits.CLAN_CREATE_COST_PC) {
      return res.status(400).json({
        error: `Недостаточно пикселькоинов. Нужно ${limits.CLAN_CREATE_COST_PC} PC, у вас ${userBalance.rows[0].pixel_coins} PC`,
      });
    }

    // Создаём клан в транзакции
    await pool.query('BEGIN');

    try {
      // Создаём клан
      const clanResult = await pool.query(
        `INSERT INTO clans (name, tag, creator_id, member_count, total_pixels, created_at)
         VALUES ($1, $2, $3, 1, 0, NOW())
         RETURNING id, name, tag, creator_id, created_at`,
        [name, tag, userId]
      );

      const clanId = clanResult.rows[0].id;

      // Добавляем создателя в участники клана (роль: leader)
      await pool.query(
        `INSERT INTO clan_members (clan_id, user_id, role, joined_at)
         VALUES ($1, $2, 'leader', NOW())`,
        [clanId, userId]
      );

      // Списываем пикселькоины
      const newBalance = userBalance.rows[0].pixel_coins - limits.CLAN_CREATE_COST_PC;
      await pool.query(
        'UPDATE users SET clan_id = $1, pixel_coins = $2 WHERE id = $3',
        [clanId, newBalance, userId]
      );

      // Записываем транзакцию
      await pool.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
         VALUES ($1, 'clan_create', $2, $3, 'PC', $4)`,
        [userId, -limits.CLAN_CREATE_COST_PC, newBalance, `Создание клана "${name}"`]
      );

      await pool.query('COMMIT');

      console.log(`[Clans] Создан клан "${name}" [${tag}] пользователем ${userId}`);

      res.json({
        success: true,
        clan: {
          id: clanId,
          name,
          tag,
          creator_id: userId,
          member_count: 1,
          total_pixels: 0,
        },
        new_balance_pc: newBalance,
      });
    } catch (txErr) {
      await pool.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error(`[Clans] Ошибка создания клана: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/clans/leaderboard — Топ-20 кланов по total_pixels
router.get('/leaderboard', async (req, res) => {
  try {
    const db = require('../services/database');
    const pool = db.getPool();

    const result = await pool.query(
      `SELECT id, name, tag, total_pixels, member_count, created_at
       FROM clans
       ORDER BY total_pixels DESC
       LIMIT 20`
    );

    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      name: row.name,
      tag: row.tag,
      total_pixels: row.total_pixels,
      member_count: row.member_count,
    }));

    res.json(leaderboard);
  } catch (err) {
    console.error(`[Clans] Ошибка лидерборда кланов: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/clans/:id — Информация о клане
router.get('/:id', async (req, res) => {
  try {
    const clanId = parseInt(req.params.id, 10);

    if (isNaN(clanId)) {
      return res.status(400).json({ error: 'Неверный ID клана' });
    }

    const db = require('../services/database');
    const pool = db.getPool();

    const clan = await pool.query(
      `SELECT id, name, tag, total_pixels, member_count, created_at
       FROM clans WHERE id = $1`,
      [clanId]
    );

    if (clan.rows.length === 0) {
      return res.status(404).json({ error: 'Клан не найден' });
    }

    // Получаем участников клана
    const members = await pool.query(
      `SELECT u.id, u.username, u.first_name, u.pixels_placed, cm.role, cm.joined_at
       FROM clan_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.clan_id = $1
       ORDER BY cm.role = 'leader' DESC, cm.joined_at ASC`,
      [clanId]
    );

    res.json({
      ...clan.rows[0],
      members: members.rows,
    });
  } catch (err) {
    console.error(`[Clans] Ошибка получения клана: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
