import { Hono } from 'hono';
import type { AppEnv, QuizListItem } from '../types';
import { authMiddleware } from '../auth';
import { ticketAuthMiddleware } from '../middleware/ticket-auth';
import { quotaCheckMiddleware } from '../middleware/quota-check';
import { isAllowedUploadMime } from './files';
import { stripExtension } from '../utils/filename';

const quiz = new Hono<AppEnv>();

const TICKET_TTL_SECONDS = 1800; // 30 分钟
const MAX_BATCH_SIZE = 500;

// ===== 类型 =====

interface QuestionRecord {
	id: string;
	user_id: string;
	quiz_id: string;
	type: string;
	content: string;
	answer: string;
	tags: string | null;
	consecutive_correct: number;
	graduated: number;
	created_at: string;
	updated_at: string;
}

interface QuizSessionRecord {
	id: string;
	user_id: string;
	quiz_id: string;
	source_file_id: string;
	status: string;
	expires_at: string;
	created_at: string;
	completed_at: string | null;
	fail_reason: string | null;
	/** 细粒度生成进度（JSON 字符串：{ phase, done, total, updatedAt }），AI Worker 随 renew 上报 */
	progress: string | null;
}

// ===== 辅助函数 =====

/** 连续答对达到此次数即毕业（固定，不可配置） */
const GRADUATION_THRESHOLD = 3;

function formatQuestion(q: QuestionRecord) {
	return {
		id: q.id,
		quizId: q.quiz_id,
		type: q.type,
		content: JSON.parse(q.content),
		answer: JSON.parse(q.answer),
		tags: q.tags ? JSON.parse(q.tags) : [],
		stats: {
			consecutiveCorrect: q.consecutive_correct,
			graduated: q.graduated,
		},
		createdAt: q.created_at,
		updatedAt: q.updated_at,
	};
}

// ===== Quizzes 路由 =====

/**
 * GET /quizzes
 * 获取用户的 Quiz 列表（含学习进度统计）
 */
quiz.get('/quizzes', authMiddleware, async (c) => {
	const userId = c.get('userId');

	const quizzes = await c.env.DB.prepare(`
		SELECT
			q.id, q.name, q.source_file_id, q.status, q.created_at, q.updated_at,
			f.name AS source_file_name,
			(SELECT COUNT(*) FROM questions WHERE quiz_id = q.id AND user_id = ?) AS total_questions,
			(SELECT COUNT(*) FROM questions WHERE quiz_id = q.id AND user_id = ? AND graduated = 1) AS graduated_questions
		FROM quizzes q
		LEFT JOIN files f ON q.source_file_id = f.id
		WHERE q.user_id = ?
		ORDER BY q.created_at DESC
	`)
		.bind(userId, userId, userId)
		.all<{
			id: string;
			name: string;
			source_file_id: string;
			source_file_name: string;
			total_questions: number;
			graduated_questions: number;
			status: string;
			created_at: string;
			updated_at: string;
		}>();

	const list: QuizListItem[] = ((quizzes.results || []) as unknown as Array<Record<string, unknown>>).map((q) => ({
		id: q.id as string,
		name: q.name as string,
		sourceFileId: q.source_file_id as string,
		sourceFileName: q.source_file_name ? stripExtension(q.source_file_name as string) : '',
		totalQuestions: q.total_questions as number,
		graduatedQuestions: q.graduated_questions as number,
		status: q.status as 'generating' | 'completed' | 'failed',
		createdAt: q.created_at as string,
		updatedAt: q.updated_at as string,
	}));

	return c.json({ data: list });
});

/**
 * GET /quizzes/:id
 * 获取单个 Quiz 详情
 */
quiz.get('/quizzes/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const quizId = c.req.param('id');

	const q = await c.env.DB.prepare(`
		SELECT
			q.*, f.name AS source_file_name,
			(SELECT COUNT(*) FROM questions WHERE quiz_id = q.id AND user_id = ?) AS total_questions,
			(SELECT COUNT(*) FROM questions WHERE quiz_id = q.id AND user_id = ? AND graduated = 1) AS graduated_questions
		FROM quizzes q
		LEFT JOIN files f ON q.source_file_id = f.id
		WHERE q.id = ? AND q.user_id = ?
	`)
		.bind(userId, userId, quizId, userId)
		.first<Record<string, unknown>>();

	if (!q) {
		return c.json({ error: 'Quiz not found' }, 404);
	}

	return c.json({
		data: {
			id: q.id,
			name: q.name,
			sourceFileId: q.source_file_id,
			sourceFileName: q.source_file_name ? stripExtension(q.source_file_name as string) : '',
			totalQuestions: q.total_questions,
			graduatedQuestions: q.graduated_questions,
			status: q.status,
			createdAt: q.created_at,
			updatedAt: q.updated_at,
		},
	});
});

/**
 * PATCH /quizzes/:id
 * 重命名 Quiz
 * Body: { "name": "新名称" }
 */
quiz.patch('/quizzes/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const quizId = c.req.param('id');

	let body: { name: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
		return c.json({ error: '"name" is required and must be a non-empty string' }, 400);
	}

	const existing = await c.env.DB.prepare(`SELECT id FROM quizzes WHERE id = ? AND user_id = ?`)
		.bind(quizId, userId)
		.first<{ id: string }>();

	if (!existing) {
		return c.json({ error: 'Quiz not found' }, 404);
	}

	const now = new Date().toISOString();
	await c.env.DB.prepare(`UPDATE quizzes SET name = ?, updated_at = ? WHERE id = ?`)
		.bind(body.name.trim(), now, quizId)
		.run();

	return c.json({ data: { id: quizId, name: body.name.trim() } });
});

/**
 * DELETE /quizzes/:id
 * 删除 Quiz 及其所有题目和作答记录
 */
quiz.delete('/quizzes/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const quizId = c.req.param('id');

	const existing = await c.env.DB.prepare(`SELECT id FROM quizzes WHERE id = ? AND user_id = ?`)
		.bind(quizId, userId)
		.first<{ id: string }>();

	if (!existing) {
		return c.json({ error: 'Quiz not found' }, 404);
	}

	// 级联删除：作答记录 → 题目 → 会话 → Quiz
	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM answer_records WHERE question_id IN (SELECT id FROM questions WHERE quiz_id = ? AND user_id = ?)`).bind(quizId, userId),
		c.env.DB.prepare(`DELETE FROM questions WHERE quiz_id = ? AND user_id = ?`).bind(quizId, userId),
		c.env.DB.prepare(`DELETE FROM quiz_sessions WHERE quiz_id = ?`).bind(quizId),
		c.env.DB.prepare(`DELETE FROM quizzes WHERE id = ? AND user_id = ?`).bind(quizId, userId),
	]);

	return c.json({ data: { deleted: true, id: quizId } });
});

/**
 * GET /quizzes/:id/questions
 * 获取 Quiz 下的所有题目
 *
 * 查询参数：
 *   - graduated: "true" 只返回已毕业，"false" 只返回未毕业，不传返回全部
 *   - type: 按题型过滤
 *   - page: 页码（默认 1）
 *   - limit: 每页数量（默认 50，最大 200）
 */
quiz.get('/quizzes/:id/questions', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const quizId = c.req.param('id');

	// 验证 Quiz 存在且属于用户
	const quizExists = await c.env.DB.prepare(`SELECT id FROM quizzes WHERE id = ? AND user_id = ?`)
		.bind(quizId, userId)
		.first<{ id: string }>();

	if (!quizExists) {
		return c.json({ error: 'Quiz not found' }, 404);
	}

	const graduatedParam = c.req.query('graduated');
	const type = c.req.query('type');
	const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
	const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
	const offset = (page - 1) * limit;

	const conditions: string[] = ['user_id = ?', 'quiz_id = ?'];
	const params: (string | number)[] = [userId, quizId];

	if (type) {
		conditions.push('type = ?');
		params.push(type);
	}
	if (graduatedParam === 'true') {
		conditions.push('graduated = 1');
	} else if (graduatedParam === 'false') {
		conditions.push('graduated = 0');
	}

	const whereClause = conditions.join(' AND ');

	const [questionsResult, countResult] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM questions WHERE ${whereClause} ORDER BY created_at ASC LIMIT ? OFFSET ?`)
			.bind(...params, limit, offset)
			.all<QuestionRecord>(),
		c.env.DB.prepare(`SELECT COUNT(*) as total FROM questions WHERE ${whereClause}`)
			.bind(...params)
			.first<{ total: number }>(),
	]);

	const questions = (questionsResult.results || []).map(formatQuestion);

	return c.json({
		data: {
			questions,
			total: countResult?.total || 0,
			page,
			limit,
		},
	});
});

// ===== Sessions 路由 =====

/**
 * POST /sessions
 * 创建 quiz session 并服务端触发 AI Worker（需要用户 JWT）
 * 支持重试：同一文档失败后可重新触发，复用 quiz_id。
 */
quiz.post('/sessions', authMiddleware, quotaCheckMiddleware, async (c) => {
	const userId = c.get('userId');

	let body: { sourceFileId: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.sourceFileId) {
		return c.json({ error: '"sourceFileId" is required' }, 400);
	}

	// 验证文件存在且属于该用户
	const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`)
		.bind(body.sourceFileId, userId)
		.first<{ id: string; r2_key: string; name: string; mime_type: string }>();

	if (!file) {
		return c.json({ error: 'Source file not found' }, 404);
	}

	if (!isAllowedUploadMime(file.mime_type)) {
		return c.json({
			error: '该文件格式不支持生成题目。请上传 txt / markdown / PDF / docx / xlsx / jpg / png / webp 格式',
		}, 415);
	}

	// 检查该文档是否已有 Quiz（UNIQUE 约束：一个文档只有一个 quiz）
	const existingQuiz = await c.env.DB.prepare(
		`SELECT id, status FROM quizzes WHERE source_file_id = ? AND user_id = ?`
	)
		.bind(body.sourceFileId, userId)
		.first<{ id: string; status: string }>();

	if (existingQuiz) {
		// ── generating：上一次还在跑（可能客户端断连但 AI 仍在处理），直接返回已有 quizId ──
		if (existingQuiz.status === 'generating') {
			return c.json({
				data: {
					quizId: existingQuiz.id,
					sessionId: existingQuiz.id,
					sourceFileName: stripExtension(file.name),
					status: 'generating',
					expiresIn: TICKET_TTL_SECONDS,
				},
			});
		}

		// ── completed：已经出好题了，无需重试 ──
		if (existingQuiz.status === 'completed') {
			return c.json({
				data: {
					quizId: existingQuiz.id,
					sessionId: existingQuiz.id,
					sourceFileName: stripExtension(file.name),
					status: 'completed',
				},
			});
		}

	// ── failed：复活原 session（同 ticket）→ 触发 AI Worker 断点续传 ──
	// 关键：ticket 必须保持 == quiz.id == 原 session.id，
	// AI Worker 的 DO 以 idFromName(ticket) 寻址，同 ticket 才能找回持有
	// 生成检查点（已生成的批次、corpus）的旧 DO 实例，实现续传而非重头再来。
	if (existingQuiz.status === 'failed') {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000);

		try {
			// 1. 清理上次可能残留的题目（防御：上传阶段中途失败可能留下半量数据）
			await c.env.DB.prepare(`DELETE FROM questions WHERE quiz_id = ?`).bind(existingQuiz.id).run();

			// 2. 复活原 session 行（而非新建）：status 回 pending、票期重置、进度清零。
			//    行不存在（被清理过）时按原 id 补建，保持 ticket == session id 不变量。
			const revived = await c.env.DB.prepare(
				`UPDATE quiz_sessions
				   SET status = 'pending', expires_at = ?, completed_at = NULL, fail_reason = NULL, progress = NULL
				 WHERE id = ? AND user_id = ?`
			).bind(expiresAt.toISOString(), existingQuiz.id, userId).run();

			if (revived.meta.changes === 0) {
				await c.env.DB.prepare(
					`INSERT INTO quiz_sessions (id, user_id, quiz_id, source_file_id, status, expires_at, created_at)
					 VALUES (?, ?, ?, ?, 'pending', ?, ?)`
				).bind(existingQuiz.id, userId, existingQuiz.id, body.sourceFileId, expiresAt.toISOString(), now.toISOString()).run();
			}

			// 3. 重置 quiz 状态
			await c.env.DB.prepare(`UPDATE quizzes SET status = 'generating', updated_at = ?, fail_reason = NULL WHERE id = ?`)
				.bind(now.toISOString(), existingQuiz.id).run();
		} catch (err) {
			console.error('DB error during quiz retry:', err);
			return c.json({ error: '数据库异常，请稍后重试' }, 500);
		}

		// 4. 重新触发 AI Worker（ticket = quiz id，与复活后的 session id 一致）
		let triggerOk = false;
		try {
			const triggerRes = await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/quiz/generate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ticket: existingQuiz.id,
					userId,
					materials: [{ r2Key: file.r2_key, mimeType: file.mime_type }],
				}),
				signal: AbortSignal.timeout(15000),
			});
			triggerOk = triggerRes.ok;
		} catch {
			triggerOk = false;
		}

		if (!triggerOk) {
			// 触发失败：session / quiz 回退 failed（DO 检查点仍在，下次重试仍可续传）
			await c.env.DB.batch([
				c.env.DB.prepare(`UPDATE quiz_sessions SET status = 'failed' WHERE id = ?`).bind(existingQuiz.id),
				c.env.DB.prepare(`UPDATE quizzes SET status = 'failed', updated_at = ? WHERE id = ?`)
					.bind(new Date().toISOString(), existingQuiz.id),
			]);
			return c.json({ error: 'AI 服务暂时不可用，请稍后重试' }, 503);
		}

		return c.json({
			data: {
				quizId: existingQuiz.id,
				sessionId: existingQuiz.id,
				sourceFileName: stripExtension(file.name),
				status: 'generating',
				expiresIn: TICKET_TTL_SECONDS,
			},
		});
	}
	}

	// ── 全新创建 ──
	const ticketId = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000);

	try {
		// 1. 创建 Quiz 实体（持久化）
		// quizzes.name 是 Quiz 的展示标题（用户之后可通过 PATCH 改名），
		// 默认取源文件名并去掉扩展名，避免标题里出现 ".txt"。
		await c.env.DB.prepare(
			`INSERT INTO quizzes (id, user_id, source_file_id, name, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'generating', ?, ?)`
		)
			.bind(ticketId, userId, body.sourceFileId, stripExtension(file.name), now.toISOString(), now.toISOString())
			.run();

		// 2. 创建出题会话（临时，到期自动清理）
		await c.env.DB.prepare(
			`INSERT INTO quiz_sessions (id, user_id, quiz_id, source_file_id, status, expires_at, created_at)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?)`
		)
			.bind(ticketId, userId, ticketId, body.sourceFileId, expiresAt.toISOString(), now.toISOString())
			.run();
	} catch (err) {
		console.error('DB error during quiz creation:', err);
		return c.json({ error: '数据库异常，请稍后重试' }, 500);
	}

	// 3. 服务端触发 AI Worker（Service Binding 内部直连，直接传 R2 key）
	let triggerOk = false;
	try {
		const triggerRes = await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/quiz/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ticket: ticketId,
				userId,
				materials: [{ r2Key: file.r2_key, mimeType: file.mime_type }],
			}),
			signal: AbortSignal.timeout(15000),
		});
		triggerOk = triggerRes.ok;
	} catch {
		triggerOk = false;
	}

	if (!triggerOk) {
		// 触发失败：清理 quiz 和 session
		await c.env.DB.batch([
			c.env.DB.prepare(`DELETE FROM quiz_sessions WHERE id = ?`).bind(ticketId),
			c.env.DB.prepare(`DELETE FROM quizzes WHERE id = ?`).bind(ticketId),
		]);
		return c.json({ error: 'AI 服务暂时不可用，请稍后重试' }, 503);
	}

	return c.json({
		data: {
			quizId: ticketId,
			sessionId: ticketId,
			sourceFileName: stripExtension(file.name),
			status: 'generating',
			expiresIn: TICKET_TTL_SECONDS,
		},
	}, 201);
});

/**
 * GET /sessions/:id
 * 查询 session / quiz 状态（需要用户 JWT）
 */
quiz.get('/sessions/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const sessionId = c.req.param('id');

	const session = await c.env.DB.prepare(`SELECT * FROM quiz_sessions WHERE id = ? AND user_id = ?`)
		.bind(sessionId, userId)
		.first<QuizSessionRecord>();

	if (!session) {
		// 也查一下 quiz（session 可能已被清理但 quiz 还在）
		const q = await c.env.DB.prepare(`SELECT * FROM quizzes WHERE id = ? AND user_id = ?`)
			.bind(sessionId, userId)
			.first<{ id: string; name: string; source_file_id: string; status: string; created_at: string; updated_at: string; fail_reason: string | null }>();

		if (!q) {
			return c.json({ error: 'Quiz not found' }, 404);
		}

		return c.json({
			data: {
				quizId: q.id,
				// 这里取的是 quizzes.name（Quiz 自己的标题，用户可 PATCH 改名），
				// 建 Quiz 时已经去过扩展名，此处不再剥离，
				// 否则会误伤"第3章.复习"这类用户自定义标题。
				sourceFileName: q.name,
				status: q.status,
				failReason: q.fail_reason ?? null,
				createdAt: q.created_at,
			},
		});
	}

	// 进度快照（细粒度）：旧数据 / 尚未开始上报时为 null，客户端按 status 降级展示
	let progress: unknown = null;
	if (session.progress) {
		try {
			progress = JSON.parse(session.progress);
		} catch {
			// 脏数据容错：当作无进度
		}
	}

	return c.json({
		data: {
			quizId: session.quiz_id,
			sessionId: session.id,
			sourceFileId: session.source_file_id,
			status: session.status,
			failReason: session.fail_reason ?? null,
			progress,
			createdAt: session.created_at,
			completedAt: session.completed_at,
			expiresAt: session.expires_at,
		},
	});
});

/**
 * PATCH /sessions/:id/status
 * AI Worker 更新 session 状态（需要 ticket 认证）
 * 同时同步更新 quizzes 表状态
 */
quiz.patch('/sessions/:id/status', ticketAuthMiddleware, async (c) => {
	const sessionId = c.req.param('id');
	const contextSessionId = c.get('sessionId');

	if (sessionId !== contextSessionId) {
		return c.json({ error: 'Ticket does not match this session' }, 403);
	}

	let body: { status: string; reason?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const validStatuses = ['processing', 'completed', 'failed'];
	if (!validStatuses.includes(body.status)) {
		return c.json({ error: `Status must be one of: ${validStatuses.join(', ')}` }, 400);
	}

	// 失败原因码白名单（AI Worker 内容审核判定），仅 failed 状态可携带
	const FAIL_REASONS = ['CONTENT_BLOCKED', 'CONTENT_REVIEW_PENDING', 'CONTENT_SCAN_UNAVAILABLE'];
	if (body.reason !== undefined && (body.status !== 'failed' || !FAIL_REASONS.includes(body.reason))) {
		return c.json({ error: `"reason" must be one of: ${FAIL_REASONS.join(', ')} and only when status is failed` }, 400);
	}
	const failReason = body.status === 'failed' ? body.reason ?? null : null;

	const completedAt = body.status === 'completed' || body.status === 'failed' ? new Date().toISOString() : null;
	const now = new Date().toISOString();

	// session 与 quiz 是两套状态词表（0005_quizzes.sql:63 vs :14）：
	// session 说"正在干活"用 processing，quiz 侧同一个事实叫 generating。
	// 直接抄会让 quizzes.status 落入清单外的值，使 :326 的复用分支永久不可达。
	const quizStatus = body.status === 'processing' ? 'generating' : body.status;

	// 同步更新 session 和 quiz 状态
	await c.env.DB.batch([
		c.env.DB.prepare(
			`UPDATE quiz_sessions SET status = ?, completed_at = COALESCE(?, completed_at), fail_reason = ? WHERE id = ?`
		).bind(body.status, completedAt, failReason, sessionId),
		c.env.DB.prepare(`UPDATE quizzes SET status = ?, updated_at = ?, fail_reason = ? WHERE id = ?`)
			.bind(quizStatus, now, failReason, sessionId),
	]);

	return c.json({ data: { sessionId, quizId: sessionId, status: body.status, failReason } });
});

/**
 * POST /sessions/:id/renew
 * AI Worker 续期 ticket（需要 ticket 认证）。
 * 将 expires_at 往后推 TICKET_TTL_SECONDS，防止长时生成任务中途过期。
 */
quiz.post('/sessions/:id/renew', ticketAuthMiddleware, async (c) => {
	const sessionId = c.req.param('id');
	const contextSessionId = c.get('sessionId');

	if (sessionId !== contextSessionId) {
		return c.json({ error: 'Ticket does not match this session' }, 403);
	}

	// 可选进度载荷（AI Worker 随续期上报）：解析失败/缺失时静默忽略、仅续期。
	// ⚠️ renew 绝不能因进度数据返回 4xx/5xx——DO 将 4xx 视为"取消信号"会直接终止任务。
	let progressJson: string | null = null;
	try {
		const body = await c.req.json();
		const p = body?.progress;
		const PROGRESS_PHASES = ['planning', 'scanning', 'generating', 'uploading'];
		if (p && typeof p === 'object' && PROGRESS_PHASES.includes(p.phase)) {
			progressJson = JSON.stringify({
				phase: p.phase,
				done: typeof p.done === 'number' && p.done >= 0 ? Math.floor(p.done) : undefined,
				total: typeof p.total === 'number' && p.total >= 0 ? Math.floor(p.total) : undefined,
				updatedAt: new Date().toISOString(),
			});
		}
	} catch {
		// 无 body / 非 JSON：仅续期
	}

	const now = new Date();
	const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000);

	await c.env.DB
		.prepare(`UPDATE quiz_sessions SET expires_at = ?, progress = COALESCE(?, progress) WHERE id = ?`)
		.bind(expiresAt.toISOString(), progressJson, sessionId)
		.run();

	return c.json({ data: { sessionId, expiresAt: expiresAt.toISOString() } });
});

/**
 * POST /sessions/:id/cancel
 * 用户取消正在进行的出题任务（需要用户 JWT）。
 * 将 session 和 quiz 状态置为 failed，AI Worker 下次续期 ticket 时会收到 4xx 从而中止。
 */
quiz.post('/sessions/:id/cancel', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const sessionId = c.req.param('id');

	const session = await c.env.DB.prepare(`SELECT * FROM quiz_sessions WHERE id = ? AND user_id = ?`)
		.bind(sessionId, userId)
		.first<QuizSessionRecord>();

	if (!session) {
		return c.json({ error: 'Session not found' }, 404);
	}

	if (session.status !== 'pending' && session.status !== 'processing') {
		return c.json({ error: `Session is already ${session.status}, cannot cancel` }, 409);
	}

	const now = new Date().toISOString();

	await c.env.DB.batch([
		c.env.DB.prepare(`UPDATE quiz_sessions SET status = 'failed', completed_at = ? WHERE id = ?`)
			.bind(now, sessionId),
		c.env.DB.prepare(`UPDATE quizzes SET status = 'failed', updated_at = ? WHERE id = ?`)
			.bind(now, sessionId),
	]);

	return c.json({ data: { sessionId, status: 'failed' } });
});

// ===== OCR 路由 =====

/**
 * POST /ocr
 * 图片转文字（需要用户 JWT）。异步：
 * AI Worker 接收后立即返回 { taskId, status: "processing" }（202），
 * 实际 OCR 由 AI Worker 的 Durable Object alarm 状态机处理。
 * 客户端通过 GET /ocr/status/:taskId 轮询结果。
 */
quiz.post('/ocr', authMiddleware, quotaCheckMiddleware, async (c) => {
	let payload: Record<string, unknown>;
	try {
		payload = (await c.req.json()) as Record<string, unknown>;
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// 注入发起用户，随图片一起透传给 AI Worker → OCR 模型调用（AI Gateway 请求标识）
	payload.userId = c.get('userId');

	let res: Response;
	try {
		res = await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/ocr', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			// AI Worker 现在立即返回 202（异步），不再同步等 OCR 结果
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		return c.json({ error: 'OCR 服务暂时不可用，请稍后重试' }, 502);
	}

	return new Response(res.body, {
		status: res.status,
		headers: { 'Content-Type': 'application/json' },
	});
});

/**
 * GET /ocr/status/:taskId
 * 轮询 OCR 任务进度和结果（需要用户 JWT）。
 * 透明转发到 AI Worker 的异步状态端点。
 */
quiz.get('/ocr/status/:taskId', authMiddleware, async (c) => {
	const taskId = c.req.param('taskId');
	if (!taskId) {
		return c.json({ error: 'taskId is required' }, 400);
	}

	let res: Response;
	try {
		res = await c.env.AI_WORKER.fetch(
			`http://we-learning-suite-ai/api/ocr/status/${encodeURIComponent(taskId)}`,
			{ signal: AbortSignal.timeout(10_000) },
		);
	} catch {
		return c.json({ error: 'OCR 服务暂时不可用，请稍后重试' }, 502);
	}

	return new Response(res.body, {
		status: res.status,
		headers: { 'Content-Type': 'application/json' },
	});
});

// ===== Questions 路由 =====

/**
 * POST /questions/batch
 * AI Worker 批量上传题目（需要 ticket 认证）
 * 支持分片上传：题目总数 > MAX_BATCH_SIZE 时由 AI Worker 切片多次调用。
 * - offset：本片第一题的全局序号（用于生成确定性 id，实现分片幂等——重发不产生重复行）
 * - final：仅最后一片为 true；只有 final 片才把 quizzes / session 置 completed
 * 两者缺省时保持旧行为（单片上传、立即 completed），向后兼容。
 */
quiz.post('/questions/batch', ticketAuthMiddleware, async (c) => {
	const userId = c.get('userId');
	const sessionId = c.get('sessionId');

	let body: {
		questions: Array<{ type: string; content: unknown; answer: unknown; tags?: string[] }>;
		offset?: unknown;
		final?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.questions || !Array.isArray(body.questions)) {
		return c.json({ error: '"questions" must be an array' }, 400);
	}

	if (body.questions.length === 0) {
		return c.json({ error: 'Empty questions array' }, 400);
	}

	if (body.questions.length > MAX_BATCH_SIZE) {
		return c.json({ error: `Maximum ${MAX_BATCH_SIZE} questions per batch` }, 400);
	}

	// offset：合法的非负整数才启用确定性 id；final：仅显式 false 才视为非末片
	const offset = typeof body.offset === 'number' && Number.isInteger(body.offset) && body.offset >= 0
		? body.offset
		: null;
	const isFinal = body.final !== false;

	// session_id 即 quiz_id
	const quizId = sessionId;
	const now = new Date().toISOString();

	// 批量插入：确定性 id（quizId-全局序号）+ INSERT OR IGNORE → 分片重发幂等。
	// D1 batch 是事务：任一语句失败整片回滚，不存在半片状态。
	const statements = body.questions.map((q, i) => {
		if (!q.type || !q.content || !q.answer) {
			return null;
		}
		const id = offset === null ? crypto.randomUUID() : `${quizId}-${offset + i}`;

		return c.env.DB.prepare(
			`INSERT OR IGNORE INTO questions (id, user_id, quiz_id, type, content, answer, tags, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(
			id, userId, quizId,
			q.type,
			JSON.stringify(q.content),
			JSON.stringify(q.answer),
			q.tags ? JSON.stringify(q.tags) : null,
			now, now,
		);
	});

	const validStatements = statements.filter((s) => s !== null);

	if (validStatements.length === 0) {
		return c.json({ error: 'No valid questions in batch (each needs type, content, answer)' }, 400);
	}

	await c.env.DB.batch(validStatements);

	// 只有最后一片才置 completed——中间片失败时 session 仍可重试 / 可复活（API 重试路径会清库重传）
	if (isFinal) {
		await c.env.DB.batch([
			c.env.DB.prepare(`UPDATE quizzes SET status = 'completed', updated_at = ? WHERE id = ?`).bind(now, quizId),
			c.env.DB.prepare(`UPDATE quiz_sessions SET status = 'completed', completed_at = ? WHERE id = ?`).bind(now, sessionId),
		]);
	}

	return c.json({
		data: {
			inserted: validStatements.length,
			quizId,
			final: isFinal,
		},
	}, 201);
});

/**
 * GET /questions
 * 获取题目列表（需要用户 JWT）
 *
 * 查询参数：
 *   - quizId: 按 Quiz 过滤
 *   - tags: 逗号分隔的标签过滤
 *   - graduated: "true" 只返回已毕业，"false" 只返回未毕业，不传返回全部
 *   - type: 按题型过滤
 *   - page / limit: 分页
 */
quiz.get('/questions', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const quizId = c.req.query('quizId');
	const tagsParam = c.req.query('tags');
	const graduatedParam = c.req.query('graduated');
	const type = c.req.query('type');
	const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
	const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
	const offset = (page - 1) * limit;

	const conditions: string[] = ['user_id = ?'];
	const params: (string | number)[] = [userId];

	if (quizId) {
		conditions.push('quiz_id = ?');
		params.push(quizId);
	}

	if (type) {
		conditions.push('type = ?');
		params.push(type);
	}

	if (graduatedParam === 'true') {
		conditions.push('graduated = 1');
	} else if (graduatedParam === 'false') {
		conditions.push('graduated = 0');
	}

	if (tagsParam) {
		const tags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
		if (tags.length > 0) {
			const tagConditions = tags.map(() => 'tags LIKE ?');
			conditions.push(`(${tagConditions.join(' OR ')})`);
			tags.forEach((t) => params.push(`%"${t}"%`));
		}
	}

	const whereClause = conditions.join(' AND ');

	const [questionsResult, countResult] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM questions WHERE ${whereClause} ORDER BY created_at ASC LIMIT ? OFFSET ?`)
			.bind(...params, limit, offset)
			.all<QuestionRecord>(),
		c.env.DB.prepare(`SELECT COUNT(*) as total FROM questions WHERE ${whereClause}`)
			.bind(...params)
			.first<{ total: number }>(),
	]);

	const questions = (questionsResult.results || []).map(formatQuestion);

	return c.json({
		data: {
			questions,
			total: countResult?.total || 0,
			page,
			limit,
		},
	});
});

/**
 * GET /questions/:id
 * 获取单题详情（需要用户 JWT）
 */
quiz.get('/questions/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const questionId = c.req.param('id');

	const q = await c.env.DB.prepare(`SELECT * FROM questions WHERE id = ? AND user_id = ?`)
		.bind(questionId, userId)
		.first<QuestionRecord>();

	if (!q) {
		return c.json({ error: 'Question not found' }, 404);
	}

	return c.json({ data: formatQuestion(q) });
});

/**
 * DELETE /questions/:id
 * 删除题目（需要用户 JWT），同时删除关联的作答记录
 */
quiz.delete('/questions/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const questionId = c.req.param('id');

	const q = await c.env.DB.prepare(`SELECT id FROM questions WHERE id = ? AND user_id = ?`)
		.bind(questionId, userId)
		.first<{ id: string }>();

	if (!q) {
		return c.json({ error: 'Question not found' }, 404);
	}

	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM answer_records WHERE question_id = ? AND user_id = ?`).bind(questionId, userId),
		c.env.DB.prepare(`DELETE FROM questions WHERE id = ? AND user_id = ?`).bind(questionId, userId),
	]);

	return c.json({ data: { deleted: true, id: questionId } });
});

// ===== Answers 路由 =====

/**
 * POST /answers
 * 批量提交作答记录 + 服务端算毕业（需要用户 JWT）
 *
 * 入参：{ answers: [{ questionId, isCorrect, userAnswer? }] }
 * 服务端对每题：答对 consecutive_correct+1，答错归 0；满 GRADUATION_THRESHOLD 次标记 graduated=1（终态）。
 */
quiz.post('/answers', authMiddleware, async (c) => {
	const userId = c.get('userId');

	let body: {
		answers: Array<{
			questionId: string;
			isCorrect: boolean;
			userAnswer?: unknown;
		}>;
	};

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.answers || !Array.isArray(body.answers) || body.answers.length === 0) {
		return c.json({ error: '"answers" must be a non-empty array' }, 400);
	}

	if (body.answers.length > MAX_BATCH_SIZE) {
		return c.json({ error: `Maximum ${MAX_BATCH_SIZE} answers per batch` }, 400);
	}

	const now = new Date().toISOString();
	const statements: ReturnType<typeof c.env.DB.prepare>[] = [];

	for (const a of body.answers) {
		if (!a.questionId || typeof a.isCorrect !== 'boolean') {
			continue;
		}

		const answerId = crypto.randomUUID();
		const isCorrectInt = a.isCorrect ? 1 : 0;

		// 1. 审计记录
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO answer_records (id, user_id, question_id, is_correct, user_answer, answered_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).bind(answerId, userId, a.questionId, isCorrectInt, a.userAnswer ? JSON.stringify(a.userAnswer) : null, now)
		);

		// 2. 原子更新：答对+1/答错归0；满阈值标记毕业（终态，已毕业不再降）
		statements.push(
			c.env.DB.prepare(
				`UPDATE questions
				 SET
				   consecutive_correct = CASE WHEN ? THEN consecutive_correct + 1 ELSE 0 END,
				   graduated = CASE
				     WHEN graduated = 1 THEN 1
				     WHEN (CASE WHEN ? THEN consecutive_correct + 1 ELSE 0 END) >= ? THEN 1
				     ELSE 0
				   END,
				   updated_at = ?
				 WHERE id = ? AND user_id = ?`
			).bind(isCorrectInt, isCorrectInt, GRADUATION_THRESHOLD, now, a.questionId, userId)
		);
	}

	if (statements.length === 0) {
		return c.json({ error: 'No valid answers in batch' }, 400);
	}

	await c.env.DB.batch(statements);

	return c.json({ data: { recorded: statements.length / 2 } }, 201);
});

// ===== 新端点：解耦后的 Quiz 创建 =====

/**
 * POST /quizzes/direct
 * 直接创建 Quiz 并写入题目（Agent 用的，不经过文档生成）
 *
 * 请求体 JSON：
 *   - name: Quiz 名称（必填）
 *   - questions: 题目数组（必填）
 *     - type: 题型（必填）
 *     - content: 题目内容（必填，JSON 字符串）
 *     - answer: 答案（必填，JSON 字符串）
 *     - tags: 标签数组（可选）
 *     - sourceFileId: 来源文档 id（可选）
 */
quiz.post('/quizzes/direct', authMiddleware, async (c) => {
	const userId = c.get('userId');

	let body: {
		name: string;
		questions: Array<{
			type: string;
			content: string;
			answer: string;
			tags?: string[];
			sourceFileId?: string;
		}>;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.name || typeof body.name !== 'string') {
		return c.json({ error: '"name" is required' }, 400);
	}
	if (!body.questions || !Array.isArray(body.questions) || body.questions.length === 0) {
		return c.json({ error: '"questions" array is required' }, 400);
	}

	const quizId = crypto.randomUUID();
	const now = new Date().toISOString();

	// 创建 Quiz 记录（status 直接 completed，因为题目已经写好了）
	await c.env.DB.prepare(
		`INSERT INTO quizzes (id, user_id, source_file_id, name, status, created_at, updated_at)
		 VALUES (?, ?, NULL, ?, 'completed', ?, ?)`
	)
		.bind(quizId, userId, body.name, now, now)
		.run();

	// 批量插入题目
	const statements = body.questions.map((q) => {
		const questionId = crypto.randomUUID();
		return c.env.DB.prepare(
			`INSERT INTO questions (id, user_id, quiz_id, type, content, answer, tags, source_file_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(
			questionId,
			userId,
			quizId,
			q.type,
			q.content,
			q.answer,
			q.tags ? JSON.stringify(q.tags) : null,
			q.sourceFileId || null,
			now,
			now
		);
	});

	await c.env.DB.batch(statements);

	return c.json({
		data: {
			id: quizId,
			name: body.name,
			questionCount: body.questions.length,
			status: 'completed',
			createdAt: now,
			updatedAt: now,
		},
	}, 201);
});

/**
 * POST /quizzes/from-file
 * 从文档生成 Quiz（支持自定义参数：题数、难度、题型等）
 *
 * 请求体 JSON：
 *   - sourceFileId: 来源文档 id（必填）
 *   - name: Quiz 名称（可选，默认用文档名）
 *   - questionCount: 题目数量（可选）
 *   - difficulty: 难度（可选）
 *   - questionTypes: 题型数组（可选）
 *   - 其他参数后续扩展
 */
quiz.post('/quizzes/from-file', authMiddleware, async (c) => {
	const userId = c.get('userId');

	let body: {
		sourceFileId: string;
		name?: string;
		questionCount?: number;
		difficulty?: string;
		questionTypes?: string[];
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.sourceFileId) {
		return c.json({ error: '"sourceFileId" is required' }, 400);
	}

	// 验证文件存在且属于该用户
	const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ? AND status = 'confirmed'`)
		.bind(body.sourceFileId, userId)
		.first<{ id: string; r2_key: string; name: string; mime_type: string }>();

	if (!file) {
		return c.json({ error: 'Source file not found' }, 404);
	}

	if (!isAllowedUploadMime(file.mime_type)) {
		return c.json({
			error: '该文件格式不支持生成题目。请上传 txt / markdown / PDF / docx / xlsx / jpg / png / webp 格式',
		}, 415);
	}

	// 新逻辑：不再限制一个文档只能有一个 Quiz
	// 直接创建新的 Quiz 和 session
	const quizId = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000);
	const quizName = body.name || stripExtension(file.name);

	try {
		// 创建 Quiz 记录
		await c.env.DB.prepare(
			`INSERT INTO quizzes (id, user_id, source_file_id, name, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'generating', ?, ?)`
		)
			.bind(quizId, userId, body.sourceFileId, quizName, now.toISOString(), now.toISOString())
			.run();

		// 创建出题会话
		await c.env.DB.prepare(
			`INSERT INTO quiz_sessions (id, user_id, quiz_id, source_file_id, status, expires_at, created_at)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?)`
		)
			.bind(quizId, userId, quizId, body.sourceFileId, expiresAt.toISOString(), now.toISOString())
			.run();
	} catch (err) {
		console.error('DB error during quiz creation:', err);
		return c.json({ error: '数据库异常，请稍后重试' }, 500);
	}

	// 触发 AI Worker
	try {
		await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/quiz/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ticket: quizId,
				userId,
				materials: [{ r2Key: file.r2_key, mimeType: file.mime_type }],
				options: {
					questionCount: body.questionCount,
					difficulty: body.difficulty,
					questionTypes: body.questionTypes,
				},
			}),
			signal: AbortSignal.timeout(15000),
		});
	} catch (e) {
		console.error('Failed to trigger AI worker:', e);
		// 不返回错误给客户端，AI Worker 是异步的，客户端轮询状态即可
	}

	return c.json({
		data: {
			quizId,
			sessionId: quizId,
			sourceFileName: stripExtension(file.name),
			status: 'generating',
			expiresIn: TICKET_TTL_SECONDS,
		},
	}, 201);
});

export { quiz };
