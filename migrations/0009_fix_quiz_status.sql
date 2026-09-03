-- 修正历史脏数据：PATCH /sessions/:id/status 曾把 quiz_sessions 词表的 'processing'
-- 无条件抄进 quizzes 表。quizzes.status 的合法值只有 generating | completed | failed
-- （见 0005_quizzes.sql:14），落入清单外的 'processing' 后，quiz.ts:326 的
-- "生成中→复用已有 quiz"分支永久不可达，二次点击出题会掉进新建分支撞
-- source_file_id UNIQUE 而返回 500。代码侧已在 quiz.ts 翻译修复，此处清理存量。
--
-- ⚠️ 时间格式：应用侧写入统一用 new Date().toISOString()（'YYYY-MM-DDTHH:MM:SS.sssZ'，
-- 空格换成 'T'、带毫秒和 'Z'），而 SQLite 的 datetime('now') 是 'YYYY-MM-DD HH:MM:SS'。
-- 直接字符串比较时 'T'(0x54) > ' '(0x20)，同一天的过期票会被误判成"未过期"，
-- 所以下面所有比较都先用 replace(substr(...,1,19),'T',' ') 归一化到秒精度。
-- 本迁移不回写 updated_at / completed_at，避免再造出第三种格式；执行时间由
-- d1_migrations 表记录。fail_reason 同样留空：0007_fail_reason.sql:2 声明的是
-- 内容审核 3 值白名单，历史卡死不属该类别。

-- 1) 没有一张仍在有效期内的票 ⇒ AI Worker 已停止续期，任务确已停摆 → 判 failed。
--    依据：活任务每轮 alarm 都会 renew 把 expires_at 推到 now+TTL(30min)
--    （quiz-generation.ts 五处 checkAndRenewTicket），30 分钟无心跳只可能是已死或已被清理。
--    判成 failed 后这些 quiz 能走 quiz.ts:354 的复活分支，被用户重试救回。
UPDATE quizzes
	SET status = 'failed'
WHERE status = 'processing'
	AND NOT EXISTS (
		SELECT 1 FROM quiz_sessions s
		 WHERE s.id = quizzes.id
			AND replace(substr(s.expires_at, 1, 19), 'T', ' ') >= datetime('now')
	);

UPDATE quiz_sessions
	SET status = 'failed'
WHERE status = 'processing'
	AND replace(substr(expires_at, 1, 19), 'T', ' ') < datetime('now');

-- 2) 其余（票确实还没过期、任务还在跑）→ 恢复成语义上正确的 generating
UPDATE quizzes
	SET status = 'generating'
WHERE status = 'processing';
