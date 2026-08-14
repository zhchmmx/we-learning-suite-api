-- 出题失败原因（AI Worker 内容审核判定等），仅 status='failed' 时有值。
-- 取值白名单：CONTENT_BLOCKED / CONTENT_REVIEW_PENDING / CONTENT_SCAN_UNAVAILABLE
ALTER TABLE quiz_sessions ADD COLUMN fail_reason TEXT;
ALTER TABLE quizzes ADD COLUMN fail_reason TEXT;
