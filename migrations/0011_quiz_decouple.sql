-- Quiz 解耦：source_file_id 从 UNIQUE 改成普通字段，允许为空
-- 为未来 Quiz 脱离文档独立存在做准备

-- SQLite 不支持直接 DROP CONSTRAINT，需要重建表
-- 1. 新表：去掉 UNIQUE，允许 source_file_id 为空
CREATE TABLE IF NOT EXISTS quizzes_new (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_file_id TEXT,  -- 不再 UNIQUE，不再 NOT NULL
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'generating',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. 复制数据
INSERT INTO quizzes_new (id, user_id, source_file_id, name, status, created_at, updated_at)
SELECT id, user_id, source_file_id, name, status, created_at, updated_at FROM quizzes;

-- 3. 删旧表
DROP TABLE quizzes;

-- 4. 新表改名
ALTER TABLE quizzes_new RENAME TO quizzes;

-- 5. 重建索引
CREATE INDEX IF NOT EXISTS idx_quizzes_user ON quizzes (user_id);
