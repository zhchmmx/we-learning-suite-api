-- 生成进度（细粒度）：AI Worker 随 renew 上报，客户端轮询读取。
-- JSON 结构：{ "phase": "planning"|"scanning"|"generating"|"uploading",
--              "done": 已生成题数, "total": 计划总题数, "updatedAt": ISO 时间 }
-- 设计取舍：单 JSON 列而非多列——scanning 阶段将来要报 files 计数，字段结构会演化。
-- 旧行为 NULL，客户端按 status 降级展示，向后兼容。
ALTER TABLE quiz_sessions ADD COLUMN progress TEXT;
