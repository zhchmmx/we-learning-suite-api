-- 文件元数据表
CREATE TABLE IF NOT EXISTS files (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	path TEXT NOT NULL DEFAULT '/',
	r2_key TEXT NOT NULL,
	size INTEGER NOT NULL DEFAULT 0,
	mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 按用户+路径查询文件列表的索引
CREATE INDEX IF NOT EXISTS idx_files_user_path ON files (user_id, path);

-- 按用户查询所有文件的索引
CREATE INDEX IF NOT EXISTS idx_files_user ON files (user_id);
