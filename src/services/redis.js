'use strict';

const Redis = require('ioredis');
const limits = require('../config/limits');

// ============================================================
// redis.js — Singleton ioredis клиент
// Один клиент для всей приложения, retry strategy для слабого VPS
// ============================================================

let client = null;
let subscriber = null;
let publisher = null;

/**
 * Создаёт и возвращает ioredis клиент (singleton)
 * Автоматический реконнект с экспоненциальной задержкой
 */
function getRedisClient() {
  if (client) return client;

  client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    // Стратегия реконнекта — для стабильности на слабом VPS
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      console.log(`[Redis] Попытка реконнекта #${times}, задержка ${delay}ms`);
      return delay;
    },
    // Макс. ожидание команды — 3 сек (не блокировать event loop)
    commandTimeout: 3000,
    // Пул соединений
    maxRetriesPerRequest: 3,
    // Включаем offline queue (команды ставятся в очередь при отключении)
    enableOfflineQueue: true,
    // Логирование
    lazyConnect: false,
  });

  client.on('connect', () => {
    console.log('[Redis] Подключён к Redis');
  });

  client.on('error', (err) => {
    console.error(`[Redis] Ошибка: ${err.message}`);
  });

  client.on('close', () => {
    console.warn('[Redis] Соединение закрыто');
  });

  client.on('reconnecting', () => {
    console.log('[Redis] Реконнект...');
  });

  return client;
}

/**
 * Возвращает отдельный клиент для подписок (pub/sub)
 * Нужен отдельный клиент, т.к. подписанный клиент не может публиковать
 */
function getSubscriber() {
  if (subscriber) return subscriber;

  subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
    lazyConnect: true,
  });

  subscriber.on('error', (err) => {
    console.error(`[Redis:Subscriber] Ошибка: ${err.message}`);
  });

  return subscriber;
}

/**
 * Возвращает отдельный клиент для публикаций (pub/sub)
 */
function getPublisher() {
  if (publisher) return publisher;

  publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
    lazyConnect: true,
  });

  publisher.on('error', (err) => {
    console.error(`[Redis:Publisher] Ошибка: ${err.message}`);
  });

  return publisher;
}

/**
 * Graceful shutdown — закрываем все Redis-соединения
 */
async function closeRedis() {
  const closeOne = async (c, name) => {
    if (c) {
      try {
        await c.quit();
        console.log(`[Redis] ${name} закрыт`);
      } catch (e) {
        console.error(`[Redis] Ошибка закрытия ${name}: ${e.message}`);
      }
    }
  };

  await Promise.all([
    closeOne(client, 'Client'),
    closeOne(subscriber, 'Subscriber'),
    closeOne(publisher, 'Publisher'),
  ]);

  client = null;
  subscriber = null;
  publisher = null;
}

module.exports = {
  getRedisClient,
  getSubscriber,
  getPublisher,
  closeRedis,
};
