'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ============================================================
// init-db.js — Инициализация базы данных
// Создаёт таблицы, индексы, стартовые данные
// Запуск: node scripts/init-db.js
// ============================================================

async function initDB() {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://pixelwars:pixelwars@localhost:5432/pixelwars';

  console.log('[InitDB] Подключение к PostgreSQL...');
  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Читаем SQL-файл
    const sqlPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');

    console.log('[InitDB] Выполнение SQL...');
    await pool.query(sql);

    console.log('[InitDB] База данных инициализирована успешно!');
    console.log('[InitDB] Таблицы: users, clans, clan_members, transactions, pixels');
  } catch (err) {
    console.error(`[InitDB] Ошибка: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initDB();
