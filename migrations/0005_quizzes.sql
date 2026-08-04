-- We Quiz: 全清重建，引入 Quiz 实体（Document 1:1 Quiz，Quiz 1:N Questions）
-- ⚠️ 此迁移会删除现有 questions / answer_records / quiz_sessions 数据

DROP TABLE IF EXISTS questions;
DROP TABLE IF EXISTS answer_records;
DROP TABLE IF EXISTS quiz_sessions;

-- Quiz 实体：一次出题的持久化结果，与源文档 1:1
CREATE TABLE IF NOT EXISTS quizzes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_file_id TEXT NOT NULL UNIQUE,  -- 一个文档只有一个 quiz
	name TEXT NOT NULL,                    -- 默认 = 文档名，可重命名
	status TEXT NOT NULL DEFAULT 'generating',  -- generating | completed | failed
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quizzes_user ON quizzes (user_id);

-- 题目表（重建：source_file_id → quiz_id）
CREATE TABLE IF NOT EXISTS questions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	quiz_id TEXT NOT NULL,
	type TEXT NOT NULL,
	content TEXT NOT NULL,
	answer TEXT NOT NULL,
	tags TEXT,
	ease_factor REAL NOT NULL DEFAULT 2.5,
	interval INTEGER NOT NULL DEFAULT 0,
	repetitions INTEGER NOT NULL DEFAULT 0,
	next_review_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_reviewed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_user ON questions (user_id);
CREATE INDEX IF NOT EXISTS idx_questions_user_review ON questions (user_id, next_review_at);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions (quiz_id);

-- 作答记录表（重建）
CREATE TABLE IF NOT EXISTS answer_records (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	question_id TEXT NOT NULL,
	is_correct INTEGER NOT NULL,
	user_answer TEXT,
	answered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_answers_user ON answer_records (user_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answer_records (question_id);
CREATE INDEX IF NOT EXISTS idx_answers_user_time ON answer_records (user_id, answered_at);

-- 出题会话表（重建）
CREATE TABLE IF NOT EXISTS quiz_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	quiz_id TEXT NOT NULL,              -- 关联到 quizzes 表
	source_file_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON quiz_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON quiz_sessions (expires_at);
