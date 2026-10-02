
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category_id TEXT,
  priority TEXT DEFAULT 'normal',
  is_completed INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0,
  deleted_at INTEGER,
  reminder_time INTEGER,
  is_reminder_sent INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sub_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  is_completed INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0,
  deleted_at INTEGER,
  reminder_time INTEGER,
  is_reminder_sent INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  telegram_id INTEGER PRIMARY KEY,
  theme TEXT DEFAULT 'mocha',
  theme_mode TEXT DEFAULT 'manual',
  accent_color TEXT DEFAULT '#89b4fa',
  language TEXT DEFAULT 'en',
  category_order TEXT,
  hidden_categories TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(telegram_id, is_deleted, is_archived, is_completed);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(telegram_id, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(reminder_time, is_reminder_sent, is_deleted, is_completed);
CREATE INDEX IF NOT EXISTS idx_tasks_cleanup ON tasks(is_deleted, deleted_at);
CREATE INDEX IF NOT EXISTS idx_sub_tasks_parent ON sub_tasks(parent_task_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_sub_tasks_reminder ON sub_tasks(reminder_time, is_reminder_sent, is_deleted, is_completed);
CREATE INDEX IF NOT EXISTS idx_sub_tasks_user ON sub_tasks(telegram_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(telegram_id);
