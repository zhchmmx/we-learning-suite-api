-- 毕业制重构：用「连续答对次数 + 终态毕业标记」替换 SM-2 间隔调度
-- 阈值固定为 3，不可配置；旧 SM-2 字段全部删除；旧题目状态不保留，全部回到未毕业、从头计。

-- 1. 先删除旧索引（它引用 next_review_at，必须在 DROP COLUMN 之前删掉，否则 SQLite 报错）
DROP INDEX IF EXISTS idx_questions_user_review;

-- 2. 新增毕业相关列
ALTER TABLE questions ADD COLUMN consecutive_correct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN graduated INTEGER NOT NULL DEFAULT 0;

-- 3. 删除旧 SM-2 列（D1 底层 SQLite >= 3.35 支持 DROP COLUMN）
--    "interval" 是 SQLite 关键字，必须双引号包裹。
ALTER TABLE questions DROP COLUMN ease_factor;
ALTER TABLE questions DROP COLUMN "interval";
ALTER TABLE questions DROP COLUMN repetitions;
ALTER TABLE questions DROP COLUMN next_review_at;
ALTER TABLE questions DROP COLUMN last_reviewed_at;

-- 4. 新建按「未毕业」筛选索引
CREATE INDEX IF NOT EXISTS idx_questions_user_graduated ON questions (user_id, graduated);
