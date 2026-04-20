'use strict';

const { Pool } = require('pg');

// ============================================================
// database.js — PostgreSQL connection pool
// Оптимизирован для слабого VPS (2 vCPU / 2-4 GB RAM)
// max: 20 connections — баланс между производительностью и памятью
// ============================================================

let pool = null;

/**
 * Возвращает singleton Pool подключение к PostgreSQL
 * Конфигурация из DATABASE_URL (env variable)
 */
function getPool() {
  if (pool) return pool;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[Database] DATABASE_URL не задан в .env');
    process.exit(1);
  }

  pool = new Pool({
    connectionString: dbUrl,
    // Оптимизация для слабого VPS
    max: 20,                  // Максимум 20 соединений
    min: 3,                   // Минимум 3 соединения (быстрый старт)
    idleTimeoutMillis: 30000, // Закрывать простаивающие через 30 сек
    connectionTimeoutMillis: 5000, // Таймаут подключения 5 сек
    maxUses: 7500,            // Перезапуск соединения после 7500 запросов
    allowExitOnIdle: false,   // Не закрывать при idle
  });

  pool.on('connect', () => {
    // Тихий лог — слишком частый для каждого соединения
  });

  pool.on('error', (err) => {
    console.error(`[Database] Неожиданная ошибка пула: ${err.message}`);
  });

  pool.on('remove', () => {
    // Соединение удалено из пула
  });

  console.log('[Database] Pool создан (max: 20, min: 3)');

  return pool;
}

/**
 * Graceful shutdown — закрываем все соединения
 */
async function closePool() {
  if (pool) {
    try {
      await pool.end();
      console.log('[Database] Pool закрыт');
      pool = null;
    } catch (err) {
      console.error(`[Database] Ошибка закрытия: ${err.message}`);
    }
  }
}

/**
 * Проверка подключения к БД
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    const p = getPool();
    const result = await p.query('SELECT NOW() AS now');
    console.log(`[Database] Подключение OK. Время сервера: ${result.rows[0].now}`);
    return true;
  } catch (err) {
    console.error(`[Database] Ошибка подключения: ${err.message}`);
    return false;
  }
}

module.exports = {
  getPool,
  closePool,
  testConnection,
};
