'use strict';

// ============================================================
// gameGate.js — Модуль подключения к игре
// Проверяет статус сервера, показывает модалку при переполнении,
// режим ожидания с автопереподключением
// Используется на фронтенде (вставляется в HTML или подключается как модуль)
// ============================================================

const GameGate = {
  // Конфигурация
  config: {
    serverUrl: window.location.origin,
    statusCheckInterval: 5000,    // Проверка статуса каждые 5 сек
    maxReconnectAttempts: 100,    // Макс. попыток автопереподключения
    reconnectDelay: 5000,         // Задержка между попытками
  },

  // Состояние
  _state: {
    socket: null,
    token: null,
    isWaiting: false,
    waitTimer: null,
    reconnectAttempts: 0,
    onConnected: null,            // Callback при успешном подключении как игрок
    onSpectator: null,            // Callback при подключении как зритель
    onDenied: null,               // Callback при отказе
  },

  /**
   * Подключение к игре
   * @param {string} token - JWT-токен пользователя
   * @param {Function} onConnected - callback(playerSocket) при подключении как игрок
   * @param {Function} onSpectator - callback(spectatorSocket) при подключении как зритель
   * @param {Function} onDenied - callback() при отказе
   */
  connect(token, onConnected, onSpectator, onDenied) {
    this._state.token = token;
    this._state.onConnected = onConnected;
    this._state.onSpectator = onSpectator;
    this._state.onDenied = onDenied;
    this._state.reconnectAttempts = 0;

    // Сначала проверяем статус сервера
    this._checkServerStatus().then((status) => {
      if (status.isFull) {
        // Сервер полон — показываем модалку
        this._showWaitingModal(status);
      } else {
        // Есть место — подключаемся
        this._connectSocket();
      }
    }).catch(() => {
      // Ошибка проверки — всё равно пробуем подключиться
      this._connectSocket();
    });
  },

  /**
   * Проверка статуса сервера
   */
  async _checkServerStatus() {
    const response = await fetch(`${this.config.serverUrl}/api/server/status`);
    return response.json();
  },

  /**
   * Подключение через Socket.io
   */
  _connectSocket() {
    // Формируем URL для WebSocket
    const wsUrl = this.config.serverUrl.replace(/^http/, 'ws');

    this._state.socket = new WebSocket(`${wsUrl}/socket.io/?EIO=4&transport=websocket&token=${this._state.token}`);

    const socket = this._state.socket;

    socket.onopen = () => {
      console.log('[GameGate] WebSocket подключён');
    };

    socket.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    socket.onerror = (err) => {
      console.error('[GameGate] Ошибка WebSocket:', err);
    };

    socket.onclose = () => {
      console.log('[GameGate] WebSocket закрыт');
      if (this._state.isWaiting) {
        // Продолжаем ждать, если в режиме ожидания
        this._scheduleReconnect();
      }
    };
  },

  /**
   * Обработка входящих сообщений Socket.io (Engine.IO формат)
   */
  _handleMessage(data) {
    try {
      // Engine.IO формат: цифра + JSON
      // 0 = open, 2 = event, 4 = message, 40 = socket.io connect, 42 = event
      if (typeof data === 'string') {
        if (data.startsWith('42')) {
          // Socket.io event
          const jsonStr = data.slice(2);
          const parsed = JSON.parse(jsonStr);
          const eventName = parsed[0];
          const eventData = parsed[1];
          this._handleEvent(eventName, eventData);
        }
      }
    } catch (err) {
      // Игнорируем ошибки парсинга
    }
  },

  /**
   * Обработка Socket.io событий
   */
  _handleEvent(eventName, data) {
    switch (eventName) {
      case 'mode:player':
        console.log('[GameGate] Подключён как игрок');
        this._state.isWaiting = false;
        this._hideWaitingModal();
        if (this._state.onConnected) {
          this._state.onConnected(this._state.socket, data);
        }
        break;

      case 'mode:spectator':
        console.log(`[GameGate] Режим зрителя (очередь: позиция ${data.yourPosition})`);
        if (!this._state.isWaiting) {
          this._showWaitingModal(data);
        }
        break;

      case 'access:denied':
        console.log(`[GameGate] Доступ запрещён: ${data.reason}`);
        this._state.isWaiting = false;
        this._hideWaitingModal();
        if (this._state.onDenied) {
          this._state.onDenied(data);
        }
        break;

      case 'error':
        if (data.code === 'kicked') {
          console.log('[GameGate] Кикнут:', data.reason);
          this._disconnect();
        }
        break;

      case 'error:kicked':
        console.log('[GameGate] Кикнут:', data.reason);
        this._disconnect();
        break;
    }
  },

  /**
   * Показать модалку ожидания
   */
  _showWaitingModal(status) {
    this._state.isWaiting = true;

    // Убираем старую модалку если есть
    this._hideWaitingModal();

    const modal = document.createElement('div');
    modal.id = 'gamegate-modal';
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.85); z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: #1a1a2e; border: 2px solid #e94560; border-radius: 16px;
      padding: 40px; text-align: center; max-width: 420px; width: 90%;
      color: #eee;
    `;

    content.innerHTML = `
      <h2 style="margin: 0 0 16px 0; color: #e94560; font-size: 24px;">
        🎮 Сервер полон
      </h2>
      <p style="margin: 0 0 8px 0; font-size: 16px; color: #aaa;">
        Онлайн: <span id="gamegate-online">${status.online || '?'}</span> / ${status.maxOnline || 65}
      </p>
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #888;">
        Ваша позиция в очереди: <span id="gamegate-position" style="color: #e94560; font-weight: bold;">${status.yourPosition || '?'}</span>
      </p>
      <div id="gamegate-waiting" style="margin: 0 0 20px 0; padding: 12px; background: rgba(233, 69, 96, 0.1); border-radius: 8px;">
        <p style="margin: 0; color: #e94560;">⏳ Ожидание свободного места...</p>
        <p style="margin: 4px 0 0 0; font-size: 12px; color: #666;">Автопереподключение каждые 5 сек</p>
      </div>
      <div style="display: flex; gap: 12px; justify-content: center;">
        <button id="gamegate-watch" style="
          padding: 12px 24px; border: 1px solid #e94560; background: transparent;
          color: #e94560; border-radius: 8px; cursor: pointer; font-size: 14px;
        ">👁 Смотреть трансляцию</button>
        <button id="gamegate-exit" style="
          padding: 12px 24px; border: 1px solid #555; background: transparent;
          color: #888; border-radius: 8px; cursor: pointer; font-size: 14px;
        ">✖ Выйти</button>
      </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Обработчики кнопок
    document.getElementById('gamegate-watch').onclick = () => {
      window.open('/spectator', '_blank');
    };

    document.getElementById('gamegate-exit').onclick = () => {
      this._disconnect();
      this._hideWaitingModal();
    };
  },

  /**
   * Скрыть модалку
   */
  _hideWaitingModal() {
    const modal = document.getElementById('gamegate-modal');
    if (modal) modal.remove();
  },

  /**
   * Планирование переподключения
   */
  _scheduleReconnect() {
    if (!this._state.isWaiting) return;
    if (this._state.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.log('[GameGate] Превышен лимит попыток переподключения');
      this._state.isWaiting = false;
      return;
    }

    this._state.reconnectAttempts++;

    // Обновляем позицию в модалке
    const posEl = document.getElementById('gamegate-position');
    if (posEl) posEl.textContent = `... (попытка ${this._state.reconnectAttempts})`;

    this._waitTimer = setTimeout(async () => {
      try {
        const status = await this._checkServerStatus();
        if (!status.isFull) {
          // Место освободилось — переподключаемся
          this._connectSocket();
        } else {
          // Всё ещё полон — обновляем и пробуем снова
          const onlineEl = document.getElementById('gamegate-online');
          if (onlineEl) onlineEl.textContent = status.online;
          if (posEl) posEl.textContent = status.estimatedQueue || '?';
          this._scheduleReconnect();
        }
      } catch (err) {
        // Ошибка сети — пробуем снова
        this._scheduleReconnect();
      }
    }, this.config.reconnectDelay);
  },

  /**
   * Отключение
   */
  _disconnect() {
    this._state.isWaiting = false;
    if (this._waitTimer) {
      clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
    if (this._state.socket) {
      this._state.socket.close();
      this._state.socket = null;
    }
  },

  /**
   * Ручное отключение (вызов извне)
   */
  disconnect() {
    this._disconnect();
    this._hideWaitingModal();
  },
};

// Экспорт для использования
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameGate;
}
if (typeof window !== 'undefined') {
  window.GameGate = GameGate;
}
