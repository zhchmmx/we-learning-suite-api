-- We Quiz: 题目表
CREATE TABLE IF NOT EXISTS questions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_file_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_questions_user_source ON questions (user_id, source_file_id);

-- We Quiz: 作答记录表
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

-- We Quiz: AI 转换会话 / 上传凭证表
CREATE TABLE IF NOT EXISTS quiz_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_file_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON quiz_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON quiz_sessions (expires_at);
