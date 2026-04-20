# Pixel Wars — Настройка Cloudflare

## Обзор защиты

Двухуровневая защита от ботов:
1. **Cloudflare (CDN)** — WAF правила, Turnstile капча, Rate Limit
2. **Сервер** — botDetection.js (поведенческий анализ, score-система)

---

## 1. Cloudflare WAF Правила

### Правило 1: Блокировка известных ботов
- **Expression:** `(cf.client.bot)`
- **Action:** Block
- **Description:** Блокирует всех известных ботов (Google, Bing и т.д. — ОСТОРОЖНО с продакшеном)

### Правило 2: Rate Limit — API запросы
- **Expression:** `http.request.uri.path contains "/api/"`
- **Rate:** 60 requests per 60 seconds per IP
- **Action:** Challenge (JavaScript)
- **Description:** Защита API от флуда

### Правило 3: Rate Limit — WebSocket handshake
- **Expression:** `http.request.uri.path contains "/socket.io/"`
- **Rate:** 10 requests per 60 seconds per IP
- **Action:** Block (temporary)
- **Description:** Защита от флуда WebSocket подключений

### Правило 4: Блокировка по Geo (опционально)
- **Expression:** `ip.geoip.country in {"CN" "RU"}`
- **Action:** Challenge
- **Description:** Капча для подозрительных регионов (настройте под вашу аудиторию)

### Правило 5: Блокировка пустых User-Agent
- **Expression:** `not http.request.full_uri contains "Mozilla"`
- **Action:** Block
- **Description:** Блокирует запросы без браузерных признаков

---

## 2. Cloudflare Turnstile

### Что это?
Невидимая капча от Cloudflare. Пользователь не видит никаких пазлов — работает в фоне.

### Настройка

1. Перейдите в Cloudflare Dashboard → Turnstile
2. Создайте новый виджет:
   - **Widget Name:** Pixel Wars Login
   - **Domain:** `pixelwars.yourdomain.com`
   - **Mode:** Managed
3. Скопируйте **Site Key** (для фронтенда) и **Secret Key** (для бэкенда)

### Интеграция — Фронтенд

```html
<!-- Добавить на страницу входа -->
<head>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>

<form id="login-form">
  <!-- Telegram Login Widget -->
  <div class="cf-turnstile"
       data-sitekey="ВАШ_SITE_KEY"
       data-callback="onTurnstileSuccess">
  </div>
</form>

<script>
function onTurnstileSuccess(token) {
  // Сохраняем токен Turnstile
  window.turnstileToken = token;
}
</script>
```

### Интеграция — Бэкенд

Токен Turnstile отправляется вместе с данными Telegram Login Widget:
```
POST /api/auth/telegram
Body: {
  id, first_name, username, photo_url, hash, auth_date,
  turnstileToken: "..."  // Токен от Cloudflare Turnstile
}
```

Сервер верифицирует Turnstile через Cloudflare API перед обработкой Telegram данных.

---

## 3. Настройка DNS

```
Type: A
Name: pixelwars
IPv4: ваш_IP_VPS
Proxy: Proxied (orange cloud) ← Обязательно для Cloudflare
TTL: Auto
```

---

## 4. SSL/TLS

- **Mode:** Full (Strict)
- **Minimum TLS Version:** 1.2
- **Always Use HTTPS:** On
- **Automatic HTTPS Rewrites:** On

---

## 5. Cache

- **Caching Level:** Standard
- **Browser Cache TTL:** 4 hours
- **Always Online:** Off (для WebSocket)

---

## 6. Дополнительные настройки

### HTTP/2
- Включить в Network → HTTP/2

### gRPC
- Включить, если понадобится

### WebSockets
- Поддерживаются автоматически через Cloudflare (проксирование WS)

### Firewall — IP Access Rules
- Добавить IP-адреса, которые нужно заблокировать навсегда

---

## .env переменные для Cloudflare

```env
TURNSTILE_SECRET_KEY=0x4AAAAAAAxxxxxxxxxxxxxxxxxxxx
FRONTEND_URL=https://pixelwars.yourdomain.com
```
