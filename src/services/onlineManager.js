'use strict';

const limits = require('../config/limits');

// ============================================================
// onlineManager.js — Менеджер онлайна
// Считает игроков и зрителей, кикает дубли и неактивных
// Данные хранятся в памяти (Map) + синхронизация в Redis
// ============================================================

class OnlineManager {
  constructor(redisClient) {
    this.redis = redisClient;
    // Map<userId, {socketId, mode, lastActivity, username}>
    this.players = new Map();
    // Map<socketId, {userId, lastActivity}>
    this.spectators = new Map();
    // Обратный индекс: socketId -> userId (для быстрого удаления)
    this.socketToUser = new Map();
    // Интервал очистки
    this._cleanupTimer = null;
  }

  /**
   * Запуск периодической очистки неактивных
   */
  startCleanup() {
    this._cleanupTimer = setInterval(
      () => this._cleanupInactive(),
      limits.CLEANUP_INTERVAL_MS
    );
    console.log(`[OnlineManager] Очистка запущена (каждые ${limits.CLEANUP_INTERVAL_MS / 1000}с)`);
  }

  /**
   * Остановка очистки
   */
  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * Попытка подключения как игрок
   * @returns {{ mode: 'player', online: number, maxOnline: number } | { mode: 'spectator', currentOnline: number, maxOnline: number, yourPosition: number }}
   */
  tryConnectAsPlayer(userId, socketId, username) {
    // Проверка на дубликат — если userId уже онлайн
    const existing = this.players.get(userId);
    if (existing && existing.socketId !== socketId) {
      return { mode: 'duplicate', existingSocketId: existing.socketId };
    }

    const playerCount = this.players.size;

    // Если есть место — подключаем как игрока
    if (playerCount < limits.MAX_ONLINE_PLAYERS) {
      this.players.set(userId, {
        socketId,
        mode: 'player',
        lastActivity: Date.now(),
        username,
      });
      this.socketToUser.set(socketId, userId);
      this._syncToRedis();
      return {
        mode: 'player',
        online: this.players.size,
        maxOnline: limits.MAX_ONLINE_PLAYERS,
      };
    }

    // Сервер полон — подключаем как зрителя
    return this._connectAsSpectator(userId, socketId);
  }

  /**
   * Подключение в режиме зрителя
   */
  _connectAsSpectator(userId, socketId) {
    if (this.spectators.size >= limits.MAX_SPECTATORS) {
      return { mode: 'denied', reason: 'server_overloaded' };
    }

    this.spectators.set(socketId, {
      userId,
      lastActivity: Date.now(),
    });

    // Позиция в очереди = количество игроков (очередь на место игрока)
    const position = this.players.size - limits.MAX_ONLINE_PLAYERS + 1;

    this._syncToRedis();
    return {
      mode: 'spectator',
      currentOnline: this.players.size,
      maxOnline: limits.MAX_ONLINE_PLAYERS,
      yourPosition: Math.max(1, position),
    };
  }

  /**
   * Обновить lastActivity для игрока/зрителя
   */
  updateActivity(socketId) {
    // Проверяем среди игроков
    for (const [userId, data] of this.players) {
      if (data.socketId === socketId) {
        data.lastActivity = Date.now();
        return;
      }
    }
    // Проверяем среди зрителей
    const spectator = this.spectators.get(socketId);
    if (spectator) {
      spectator.lastActivity = Date.now();
    }
  }

  /**
   * Отключение по socketId
   */
  disconnect(socketId) {
    // Удаляем из игроков
    const userId = this.socketToUser.get(socketId);
    if (userId) {
      this.players.delete(userId);
      this.socketToUser.delete(socketId);
    }

    // Удаляем из зрителей
    this.spectators.delete(socketId);

    this._syncToRedis();
  }

  /**
   * Найти socketId по userId (для кика дубля)
   */
  findSocketByUserId(userId) {
    const player = this.players.get(userId);
    return player ? player.socketId : null;
  }

  /**
   * Получить текущую статистику
   */
  getStatus() {
    return {
      online: this.players.size,
      maxOnline: limits.MAX_ONLINE_PLAYERS,
      spectators: this.spectators.size,
      maxSpectators: limits.MAX_SPECTATORS,
      isFull: this.players.size >= limits.MAX_ONLINE_PLAYERS,
      estimatedQueue: Math.max(0, this.players.size - limits.MAX_ONLINE_PLAYERS + 1),
    };
  }

  /**
   * Очистка неактивных подключений
   * Все сокеты с lastActivity старше INACTIVE_TIMEOUT кикаются
   */
  _cleanupInactive() {
    const now = Date.now();
    const timeout = limits.INACTIVE_TIMEOUT_MS;
    let kickedPlayers = 0;
    let kickedSpectators = 0;

    // Очистка игроков
    for (const [userId, data] of this.players) {
      if (now - data.lastActivity > timeout) {
        this.players.delete(userId);
        this.socketToUser.delete(data.socketId);
        kickedPlayers++;
      }
    }

    // Очистка зрителей
    for (const [socketId, data] of this.spectators) {
      if (now - data.lastActivity > timeout) {
        this.spectators.delete(socketId);
        kickedSpectators++;
      }
    }

    if (kickedPlayers > 0 || kickedSpectators > 0) {
      console.log(
        `[OnlineManager] Очистка: ${kickedPlayers} игроков, ${kickedSpectators} зрителей. ` +
        `Онлайн: ${this.players.size}/${limits.MAX_ONLINE_PLAYERS}, ` +
        `Зрители: ${this.spectators.size}/${limits.MAX_SPECTATORS}`
      );
      this._syncToRedis();
    }
  }

  /**
   * Синхронизация счётчиков в Redis (для cross-process и API)
   */
  async _syncToRedis() {
    try {
      if (!this.redis || this.redis.status !== 'ready') return;

      await this.redis.set(limits.REDIS_KEYS.ONLINE_PLAYERS, this.players.size);
      await this.redis.set(limits.REDIS_KEYS.ONLINE_SPECTATORS, this.spectators.size);
    } catch (err) {
      console.error(`[OnlineManager] Ошибка синхронизации Redis: ${err.message}`);
    }
  }
}

module.exports = OnlineManager;
