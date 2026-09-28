-- 文件同步支持：content_hash + doc_type + parent_id
ALTER TABLE files ADD COLUMN content_hash TEXT;
ALTER TABLE files ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'rendered';
ALTER TABLE files ADD COLUMN parent_id TEXT;

-- 索引：按父文件查批注
CREATE INDEX IF NOT EXISTS idx_files_parent ON files (user_id, parent_id);

-- 图片元数据表（存储到 Backblaze B2）
CREATE TABLE IF NOT EXISTS images (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	parent_file_id TEXT NOT NULL,
	b2_key TEXT NOT NULL,
	content_hash TEXT,
	mime_type TEXT NOT NULL,
	size INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 按用户+文档查图片
CREATE INDEX IF NOT EXISTS idx_images_user_file ON images (user_id, parent_file_id);
