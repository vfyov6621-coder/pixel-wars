-- ============================================================
-- Pixel Wars — Схема базы данных PostgreSQL
-- Таблицы: users, clans, clan_members, transactions, pixels
-- ============================================================

-- Пользователи
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    telegram_id     BIGINT UNIQUE NOT NULL,
    username        VARCHAR(32) UNIQUE NOT NULL,
    first_name      VARCHAR(64),
    photo_url       TEXT,
    pixel_coins     INTEGER DEFAULT 0 CHECK (pixel_coins >= 0),
    black_coins     INTEGER DEFAULT 0 CHECK (black_coins >= 0),
    pixels_placed   INTEGER DEFAULT 0 CHECK (pixels_placed >= 0),
    clan_id         INTEGER REFERENCES clans(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Кланы
CREATE TABLE IF NOT EXISTS clans (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(32) UNIQUE NOT NULL,
    tag             VARCHAR(5) UNIQUE NOT NULL,
    creator_id      INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_pixels    INTEGER DEFAULT 0 CHECK (total_pixels >= 0),
    member_count    INTEGER DEFAULT 1 CHECK (member_count >= 1),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Участники кланов
CREATE TABLE IF NOT EXISTS clan_members (
    clan_id         INTEGER REFERENCES clans(id) ON DELETE CASCADE,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(16) DEFAULT 'member' CHECK (role IN ('leader', 'officer', 'member')),
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (clan_id, user_id)
);

-- История транзакций (PC/BC)
CREATE TABLE IF NOT EXISTS transactions (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(32) NOT NULL,
    amount          INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
    currency        VARCHAR(3) NOT NULL CHECK (currency IN ('PC', 'BC')),
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- История поставленных пикселей
CREATE TABLE IF NOT EXISTS pixels (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    x               INTEGER NOT NULL CHECK (x >= 0 AND x < 1000),
    y               INTEGER NOT NULL CHECK (y >= 0 AND y < 1000),
    color           VARCHAR(7) NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    placed_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_pixels_placed_at ON pixels(placed_at);
CREATE INDEX IF NOT EXISTS idx_pixels_user_id ON pixels(user_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_clan_id ON users(clan_id);
CREATE INDEX IF NOT EXISTS idx_users_pixels_placed ON users(pixels_placed DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_clans_total_pixels ON clans(total_pixels DESC);
CREATE INDEX IF NOT EXISTS idx_clan_members_user_id ON clan_members(user_id);
