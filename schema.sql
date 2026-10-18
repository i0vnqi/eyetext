-- schema.sql
-- تصميم قاعدة بيانات نظام "لوحة الكتابة بتتبع النظر" (EyeText)
-- محرك القاعدة: PostgreSQL

-- ============================================================
-- 1) المستخدمون
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    user_id        SERIAL PRIMARY KEY,
    full_name      VARCHAR(255) NOT NULL,
    email          VARCHAR(255) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    password_salt  VARCHAR(255) NOT NULL,
    role           VARCHAR(50)  NOT NULL DEFAULT 'patient',   -- patient | caregiver | admin
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 2) الجلسات: كل مرة يسجّل فيها المستخدم دخول ويستخدم النظام
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    session_id     SERIAL PRIMARY KEY,
    user_id        INT          NOT NULL REFERENCES users(user_id),
    token          VARCHAR(100) NOT NULL UNIQUE,
    dwell_ms       INT          NOT NULL DEFAULT 5000,
    start_time     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time       TIMESTAMP    NULL
);

-- ============================================================
-- 3) سجلات المعايرة لكل جلسة
-- ============================================================
CREATE TABLE IF NOT EXISTS calibrations (
    calibration_id SERIAL PRIMARY KEY,
    session_id     INT       NOT NULL REFERENCES sessions(session_id),
    points_count   INT       NOT NULL,
    completed_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 4) الرسائل: النص الكامل الذي كتبه المستخدم بجلسة معيّنة
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
    message_id     SERIAL PRIMARY KEY,
    session_id     INT       NOT NULL REFERENCES sessions(session_id),
    user_id        INT       NOT NULL REFERENCES users(user_id),
    full_text      TEXT      NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 5) اختيارات الحروف: سجل تفصيلي لكل حرف تم اختياره
-- ============================================================
CREATE TABLE IF NOT EXISTS letter_selections (
    selection_id   SERIAL PRIMARY KEY,
    session_id     INT         NOT NULL REFERENCES sessions(session_id),
    message_id     INT         NULL REFERENCES messages(message_id),
    letter         VARCHAR(10) NOT NULL,
    sequence_order INT         NOT NULL,
    dwell_time_ms  INT         NOT NULL,
    confirmed_by   VARCHAR(20) NOT NULL DEFAULT 'blink',   -- blink | timeout
    selected_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 6) فهارس: PostgreSQL لا ينشئ فهرسًا تلقائيًا على المفاتيح الأجنبية
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_calibrations_sess  ON calibrations(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_letters_session    ON letter_selections(session_id);
CREATE INDEX IF NOT EXISTS idx_letters_message    ON letter_selections(message_id);

-- ============================================================
-- 7) رموز إعادة تعيين كلمة المرور (نسيت كلمة المرور)
--    نخزّن بصمة الرمز (SHA-256) وليس الرمز نفسه؛ الرمز الأصلي يوجد فقط في رابط البريد.
-- ============================================================
CREATE TABLE IF NOT EXISTS password_resets (
    reset_id    SERIAL PRIMARY KEY,
    user_id     INT          NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash  VARCHAR(64)  NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ  NOT NULL,
    used_at     TIMESTAMPTZ  NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
