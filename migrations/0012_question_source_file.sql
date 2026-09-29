-- 题目增加来源文档字段：标记每道题来自哪个文档
-- 文档删除后题目仍保留，只是 source_file_id 指向一个不存在的文件
ALTER TABLE questions ADD COLUMN source_file_id TEXT;

-- 索引：按文档查题目
CREATE INDEX IF NOT EXISTS idx_questions_source_file ON questions (user_id, source_file_id);
