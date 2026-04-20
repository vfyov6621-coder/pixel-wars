'use strict';

const limits = require('../config/limits');

// ============================================================
// botDetection.js — Поведенческий антибот (2-я линия защиты)
// Score-система: анализ User-Agent, заголовков, частоты подключений
// Score >= 100 → бан IP на 1 час в Redis
// ============================================================

/**
 * Анализирует входящее подключение на предмет ботов
 * @param {Object} req - Express/Socket.io handshake request
 * @param {Object} redisClient - Redis клиент
 * @returns {Promise<{allowed: boolean, score: number, reason: string|null, banned: boolean}>}
 */
async function analyzeConnection(req, redisClient) {
  if (!req || !req.headers) {
    return { allowed: true, score: 0, reason: null, banned: false };
  }

  // Извлекаем реальный IP из Cloudflare заголовка
  const ip = req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
  let totalScore = 0;
  const violations = [];

  // --- Проверка 1: IP уже забанен? ---
  if (redisClient) {
    try {
      const isBanned = await redisClient.get(limits.REDIS_KEYS.BOT_BAN(ip));
      if (isBanned) {
        console.log(`[BotDetect] IP ${ip} забанен (предыдущие нарушения)`);
        return { allowed: false, score: 999, reason: 'ip_banned', banned: true };
      }

      // Получаем текущий score
      const existingScore = await redisClient.get(limits.REDIS_KEYS.BOT_SCORE(ip));
      if (existingScore) {
        totalScore = parseInt(existingScore, 10) || 0;
      }
    } catch (err) {
      console.error(`[BotDetect] Ошибка Redis: ${err.message}`);
    }
  }

  // --- Проверка 2: User-Agent ---
  const ua = req.headers['user-agent'] || '';
  if (!ua || ua.length < 20) {
    totalScore += 40;
    violations.push('empty_or_short_ua');
  } else {
    // Подозрительные UA: curl, wget, python-requests, okhttp без браузерных признаков
    const suspiciousPatterns = /curl|wget|python-requests|httpclient|okhttp|java\/|go-http/i;
    if (suspiciousPatterns.test(ua)) {
      totalScore += 50;
      violations.push('suspicious_ua');
    }

    // Отсутствие стандартных браузерных строк
    const browserPatterns = /Mozilla|Chrome|Firefox|Safari|Edge/i;
    if (!browserPatterns.test(ua)) {
      totalScore += 30;
      violations.push('non_browser_ua');
    }
  }

  // --- Проверка 3: Sec-Fetch заголовки ---
  const secFetchMode = req.headers['sec-fetch-mode'];
  const secFetchSite = req.headers['sec-fetch-site'];
  const secFetchDest = req.headers['sec-fetch-dest'];

  if (!secFetchMode && !secFetchSite && !secFetchDest) {
    // Для WebSocket обновления заголовки могут отсутствовать — не штрафуем жёстко
    totalScore += 10;
    violations.push('missing_sec_fetch');
  } else {
    if (secFetchMode && secFetchMode !== 'websocket' && secFetchMode !== 'navigate' && secFetchMode !== 'cors') {
      totalScore += 20;
      violations.push('suspicious_sec_fetch_mode');
    }
  }

  // --- Проверка 4: Accept-Language ---
  const acceptLang = req.headers['accept-language'] || '';
  if (!acceptLang) {
    totalScore += 15;
    violations.push('no_accept_language');
  }

  // --- Проверка 5: Flood подключений (краткосрочно) ---
  if (redisClient) {
    try {
      const connKey = `bot:conn_count:${ip}`;
      const connCount = await redisClient.incr(connKey);
      if (connCount === 1) {
        await redisClient.pexpire(connKey, 60000); // 1 минута
      }
      if (connCount > limits.RATE_LIMIT_WS_HANDSHAKE) {
        totalScore += 40;
        violations.push('connection_flood');
      }
    } catch (err) {
      // Игнорируем ошибки Redis
    }
  }

  // --- Проверка 6: Telegram авторизация (проверка формата hash) ---
  const telegramHash = req.body?.hash || req.query?.hash;
  if (!telegramHash && req.path?.includes('/auth')) {
    totalScore += 10;
    violations.push('missing_telegram_hash');
  }

  // --- Сохраняем score и принимаем решение ---
  const isBot = totalScore >= limits.BOT_BAN_THRESHOLD;

  if (redisClient) {
    try {
      if (totalScore > 0) {
        await redisClient.set(
          limits.REDIS_KEYS.BOT_SCORE(ip),
          totalScore.toString(),
          'PX',
          limits.BOT_SCORE_TTL_MS
        );
      }

      // Бан при превышении порога
      if (isBot) {
        await redisClient.set(
          limits.REDIS_KEYS.BOT_BAN(ip),
          JSON.stringify({
            score: totalScore,
            violations,
            timestamp: Date.now(),
          }),
          'PX',
          limits.BOT_BAN_DURATION_MS
        );
        console.warn(`[BotDetect] IP ${ip} ЗАБАНЕН. Score: ${totalScore}. Причины: ${violations.join(', ')}`);
      }
    } catch (err) {
      console.error(`[BotDetect] Ошибка сохранения score: ${err.message}`);
    }
  }

  if (totalScore > 0) {
    console.log(`[BotDetect] IP ${ip}: score=${totalScore}, нарушения: [${violations.join(', ')}]`);
  }

  return {
    allowed: !isBot,
    score: totalScore,
    reason: isBot ? violations.join(', ') : null,
    banned: isBot,
  };
}

/**
 * Репорт подозрительной активности в runtime
 * Увеличивает score на указанное значение
 */
async function reportSuspiciousActivity(ip, redisClient, points = 20, reason = 'manual_report') {
  if (!redisClient || !ip) return;

  try {
    const scoreKey = limits.REDIS_KEYS.BOT_SCORE(ip);
    const current = parseInt(await redisClient.get(scoreKey) || '0', 10);
    const newScore = current + points;

    await redisClient.set(scoreKey, newScore.toString(), 'PX', limits.BOT_SCORE_TTL_MS);

    console.log(`[BotDetect] Репорт: IP ${ip} +${points} очков (теперь ${newScore}). Причина: ${reason}`);

    // Автоматический бан если превысили порог
    if (newScore >= limits.BOT_BAN_THRESHOLD) {
      await redisClient.set(
        limits.REDIS_KEYS.BOT_BAN(ip),
        JSON.stringify({ score: newScore, reason, timestamp: Date.now() }),
        'PX',
        limits.BOT_BAN_DURATION_MS
      );
      console.warn(`[BotDetect] IP ${ip} забанен после репорта (score: ${newScore})`);
    }
  } catch (err) {
    console.error(`[BotDetect] Ошибка репорта: ${err.message}`);
  }
}

module.exports = {
  analyzeConnection,
  reportSuspiciousActivity,
};
