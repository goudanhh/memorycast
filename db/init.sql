CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id BIGINT UNIQUE NOT NULL,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_pkey";
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE TABLE IF NOT EXISTS cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  example TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  speak_order TEXT NOT NULL DEFAULT 'front-back-example',
  fsrs JSONB NOT NULL,
  due TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  review_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cards_user_due ON cards(user_id, due);
CREATE INDEX IF NOT EXISTS idx_cards_user_category ON cards(user_id, category);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'review',
  rating TEXT NOT NULL,
  verdict TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_user_time ON reviews(user_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_card_time ON reviews(card_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS quiz_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '今日测试',
  questions JSONB NOT NULL,
  answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_quiz_user_created ON quiz_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  english_rate REAL NOT NULL DEFAULT 1.0,
  chinese_rate REAL NOT NULL DEFAULT 1.0,
  daily_goal INTEGER NOT NULL DEFAULT 20,
  fsrs_retention REAL NOT NULL DEFAULT 0.90,
  wrong_requeue BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_time TIME NOT NULL DEFAULT '09:00',
  reminder_timezone TEXT NOT NULL DEFAULT 'UTC',
  last_reminder_date DATE,
  ai_organize_provider TEXT NOT NULL DEFAULT 'gemini',
  ai_quiz_provider TEXT NOT NULL DEFAULT 'gemini',
  ai_grade_provider TEXT NOT NULL DEFAULT 'gemini',
  ai_feynman_provider TEXT NOT NULL DEFAULT 'gemini',
  stt_provider TEXT NOT NULL DEFAULT 'cloudflare',
  ocr_provider TEXT NOT NULL DEFAULT 'gemini',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


ALTER TABLE cards ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[];


CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '未命名笔记',
  content TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  manual_review_count INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS note_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  data BYTEA NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_attachment_id UUID,
  page_number INTEGER,
  is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_attachments_note
  ON note_attachments(note_id, sort_order, created_at);


ALTER TABLE cards ADD COLUMN IF NOT EXISTS source_note_id UUID REFERENCES notes(id) ON DELETE CASCADE;


ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_source_note_id_fkey;
ALTER TABLE cards
  ADD CONSTRAINT cards_source_note_id_fkey
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE;


CREATE TABLE IF NOT EXISTS feynman_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  clarity_score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_turn_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feynman_sessions_user_updated
  ON feynman_sessions(user_id, last_turn_at DESC);

CREATE TABLE IF NOT EXISTS feynman_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES feynman_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','ai')),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feynman_turns_session_time
  ON feynman_turns(session_id, created_at ASC, id ASC);
