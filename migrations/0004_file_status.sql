-- 添加文件状态列，用于预签名上传的确认机制
-- status: 'confirmed' = 正常文件, 'pending' = 预签名上传中（未确认）
ALTER TABLE files ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';

-- 索引用于清理超时的 pending 文件（幽灵文件）
CREATE INDEX IF NOT EXISTS idx_files_status ON files (status);
