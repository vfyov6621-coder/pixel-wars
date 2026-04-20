'use strict';

const express = require('express');
const router = express.Router();
const limits = require('../config/limits');
const { authMiddleware } = require('./profile');

// ============================================================
// shop.js — Магазин: покупка бустера, обмен PC→BC
// ============================================================

// POST /api/shop/buy-booster — Покупка бустера за 10 BC
router.post('/buy-booster', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const db = require('../services/database');
    const pool = db.getPool();
    const { getRedisClient } = require('../services/redis');
    const redis = getRedisClient();

    // Проверяем баланс BC
    const user = await pool.query(
      'SELECT black_coins FROM users WHERE id = $1',
      [userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const currentBC = user.rows[0].black_coins;

    if (currentBC < limits.BOOSTER_COST_BC) {
      return res.status(400).json({
        success: false,
        error: `Недостаточно блэккоинов. Нужно ${limits.BOOSTER_COST_BC} BC, у вас ${currentBC} BC`,
      });
    }

    // Проверяем, нет ли уже активного бустера
    if (redis && redis.status === 'ready') {
      const boosterTTL = await redis.pttl(limits.REDIS_KEYS.ACTIVE_BOOSTER(userId));
      if (boosterTTL > 0) {
        const remainingSec = Math.ceil(boosterTTL / 1000);
        return res.status(400).json({
          success: false,
          error: `Бустер уже активен. Осталось ${remainingSec} сек.`,
          remaining: remainingSec,
        });
      }
    }

    // Списываем BC в транзакции
    await pool.query('BEGIN');

    try {
      const newBC = currentBC - limits.BOOSTER_COST_BC;

      await pool.query(
        'UPDATE users SET black_coins = $1 WHERE id = $2',
        [newBC, userId]
      );

      // Записываем транзакцию
      await pool.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
         VALUES ($1, 'booster_buy', $2, $3, 'BC', 'Покупка бустера')`,
        [userId, -limits.BOOSTER_COST_BC, newBC]
      );

      await pool.query('COMMIT');

      // Устанавливаем бустер в Redis (TTL = длительность бустера)
      if (redis && redis.status === 'ready') {
        await redis.set(
          limits.REDIS_KEYS.ACTIVE_BOOSTER(userId),
          'active',
          'PX',
          limits.BOOSTER_DURATION_S * 1000
        );
      }

      console.log(`[Shop] Бустер куплен пользователем ${userId}`);

      res.json({
        success: true,
        duration: limits.BOOSTER_DURATION_S,
        cooldown: limits.PIXEL_COOLDOWN_BOOSTER_MS / 1000,
        new_balance_bc: newBC,
      });
    } catch (txErr) {
      await pool.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error(`[Shop] Ошибка покупки бустера: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// POST /api/shop/exchange — Обмен PC→BC (100:1, кратно 100)
router.post('/exchange', authMiddleware, async (req, res) => {
  try {
    const { amount_pc } = req.body;
    const userId = req.user.userId;

    // Валидация
    if (!amount_pc || !Number.isInteger(amount_pc)) {
      return res.status(400).json({ error: 'Укажите целое количество PC для обмена' });
    }

    if (amount_pc < limits.EXCHANGE_RATE_PC_TO_BC || amount_pc % limits.EXCHANGE_RATE_PC_TO_BC !== 0) {
      return res.status(400).json({
        error: `Количество PC должно быть кратно ${limits.EXCHANGE_RATE_PC_TO_BC} (минимум ${limits.EXCHANGE_RATE_PC_TO_BC})`,
      });
    }

    const receivedBC = amount_pc / limits.EXCHANGE_RATE_PC_TO_BC;

    const db = require('../services/database');
    const pool = db.getPool();

    // Проверяем баланс
    const user = await pool.query(
      'SELECT pixel_coins, black_coins FROM users WHERE id = $1',
      [userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const currentPC = user.rows[0].pixel_coins;
    const currentBC = user.rows[0].black_coins;

    if (currentPC < amount_pc) {
      return res.status(400).json({
        error: `Недостаточно пикселькоинов. Нужно ${amount_pc} PC, у вас ${currentPC} PC`,
      });
    }

    // Обмен в транзакции
    await pool.query('BEGIN');

    try {
      const newPC = currentPC - amount_pc;
      const newBC = currentBC + receivedBC;

      await pool.query(
        'UPDATE users SET pixel_coins = $1, black_coins = $2 WHERE id = $3',
        [newPC, newBC, userId]
      );

      // Записываем транзакции (PC - списание, BC + начисление)
      await pool.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
         VALUES ($1, 'exchange_pc', $2, $3, 'PC', 'Обмен PC → BC')`,
        [userId, -amount_pc, newPC]
      );

      await pool.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, currency, description)
         VALUES ($1, 'exchange_bc', $2, $3, 'BC', 'Обмен PC → BC')`,
        [userId, receivedBC, newBC]
      );

      await pool.query('COMMIT');

      console.log(`[Shop] Обмен: пользователь ${userId} обменял ${amount_pc} PC на ${receivedBC} BC`);

      res.json({
        success: true,
        pc_deducted: amount_pc,
        bc_received: receivedBC,
        new_balance_pc: newPC,
        new_balance_bc: newBC,
      });
    } catch (txErr) {
      await pool.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error(`[Shop] Ошибка обмена валют: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
