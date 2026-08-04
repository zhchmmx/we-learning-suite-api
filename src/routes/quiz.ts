import { Hono } from 'hono';
import type { AppEnv, QuizListItem } from '../types';
import { authMiddleware } from '../auth';
import { ticketAuthMiddleware } from '../middleware/ticket-auth';
import { isAllowedUploadMime } from './files';

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
	ease_factor: number;
	interval: number;
	repetitions: number;
	next_review_at: string;
	last_reviewed_at: string | null;
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
}

// ===== 辅助函数 =====

/** 计算已掌握题目数（SM-2 间隔 >= 21 天视为已掌握） */
const MASTERED_INTERVAL_DAYS = 21;

function formatQuestion(q: QuestionRecord) {
	return {
		id: q.id,
		quizId: q.quiz_id,
		type: q.type,
		content: JSON.parse(q.content),
		answer: JSON.parse(q.answer),
		tags: q.tags ? JSON.parse(q.tags) : [],
		schedule: {
			easeFactor: q.ease_factor,
			interval: q.interval,
			repetitions: q.repetitions,
			nextReviewAt: q.next_review_at,
			lastReviewedAt: q.last_reviewed_at,
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
			(SELECT COUNT(*) FROM questions WHERE quiz_id = q.id AND user_id = ? AND "interval" >= ${MASTERED_INTERVAL_DAYS}) AS mastered_questions
		FROM quizzes q
		JOIN files f ON q.source_file_id = f.id
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
			mastered_questions: number;
			status: string;
			created_at: string;
			updated_at: string;
		}>();

	const list: QuizListItem[] = ((quizzes.results || []) as unknown as Array<Record<string, unknown>>).map((q) => ({
		id: q.id as string,
		name: q.name as string,
		sourceFileId: q.source_file_id as string,
		sourceFileName: q.source_file_name as string,
		totalQuestions: q.total_questions as number,
		masteredQuestions: q.mastered_questions as number,
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
			(SELECT COUNT(*) FROM questions WHERE quiz_id = q.id AND user_id = ? AND "interval" >= ${MASTERED_INTERVAL_DAYS}) AS mastered_questions
		FROM quizzes q
		JOIN files f ON q.source_file_id = f.id
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
			sourceFileName: q.source_file_name,
			totalQuestions: q.total_questions,
			masteredQuestions: q.mastered_questions,
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
 *   - due: "true" 只返回到期题目
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

	const due = c.req.query('due') === 'true';
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
	if (due) {
		conditions.push('next_review_at <= ?');
		params.push(new Date().toISOString());
	}

	const whereClause = conditions.join(' AND ');

	const [questionsResult, countResult] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM questions WHERE ${whereClause} ORDER BY next_review_at ASC LIMIT ? OFFSET ?`)
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
 * 同时创建 Quiz 实体（status=generating），quiz_id = session_id
 */
quiz.post('/sessions', authMiddleware, async (c) => {
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
			error: '该文档不是文本格式，无法生成题目。请将其转换为文本（txt/md）后重新上传',
		}, 415);
	}

	// 生成 ticket（同时也是 quiz_id）
	const ticketId = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000);

	// 1. 创建 Quiz 实体（持久化）
	await c.env.DB.prepare(
		`INSERT INTO quizzes (id, user_id, source_file_id, name, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'generating', ?, ?)`
	)
		.bind(ticketId, userId, body.sourceFileId, file.name, now.toISOString(), now.toISOString())
		.run();

	// 2. 创建出题会话（临时，到期自动清理）
	await c.env.DB.prepare(
		`INSERT INTO quiz_sessions (id, user_id, quiz_id, source_file_id, status, expires_at, created_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?)`
	)
		.bind(ticketId, userId, ticketId, body.sourceFileId, expiresAt.toISOString(), now.toISOString())
		.run();

	// 3. 服务端触发 AI Worker（Service Binding 内部直连，直接传 R2 key）
	let triggerOk = false;
	try {
		const triggerRes = await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/quiz/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ticket: ticketId,
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
			sourceFileName: file.name,
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
			.first<{ id: string; name: string; source_file_id: string; status: string; created_at: string; updated_at: string }>();

		if (!q) {
			return c.json({ error: 'Quiz not found' }, 404);
		}

		return c.json({
			data: {
				quizId: q.id,
				sourceFileName: q.name,
				status: q.status,
				createdAt: q.created_at,
			},
		});
	}

	return c.json({
		data: {
			quizId: session.quiz_id,
			sessionId: session.id,
			sourceFileId: session.source_file_id,
			status: session.status,
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

	let body: { status: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const validStatuses = ['processing', 'completed', 'failed'];
	if (!validStatuses.includes(body.status)) {
		return c.json({ error: `Status must be one of: ${validStatuses.join(', ')}` }, 400);
	}

	const completedAt = body.status === 'completed' || body.status === 'failed' ? new Date().toISOString() : null;
	const now = new Date().toISOString();

	// 同步更新 session 和 quiz 状态
	await c.env.DB.batch([
		c.env.DB.prepare(`UPDATE quiz_sessions SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`)
			.bind(body.status, completedAt, sessionId),
		c.env.DB.prepare(`UPDATE quizzes SET status = ?, updated_at = ? WHERE id = ?`)
			.bind(body.status, now, sessionId),
	]);

	return c.json({ data: { sessionId, quizId: sessionId, status: body.status } });
});

// ===== OCR 路由 =====

/**
 * POST /ocr
 * 图片转文字（需要用户 JWT）。
 */
quiz.post('/ocr', authMiddleware, async (c) => {
	const body = c.req.raw.body;
	if (!body) {
		return c.json({ error: 'Empty request body' }, 400);
	}

	let res: Response;
	try {
		res = await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/ocr', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			signal: AbortSignal.timeout(5 * 60 * 1000),
		});
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
 * 入库时挂 quiz_id，同时更新 quizzes 状态为 completed
 */
quiz.post('/questions/batch', ticketAuthMiddleware, async (c) => {
	const userId = c.get('userId');
	const sessionId = c.get('sessionId');

	let body: { questions: Array<{ type: string; content: unknown; answer: unknown; tags?: string[] }> };
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

	// session_id 即 quiz_id
	const quizId = sessionId;
	const now = new Date().toISOString();

	// 批量插入
	const insertedIds: string[] = [];
	const statements = body.questions.map((q) => {
		const id = crypto.randomUUID();
		insertedIds.push(id);

		if (!q.type || !q.content || !q.answer) {
			return null;
		}

		return c.env.DB.prepare(
			`INSERT INTO questions (id, user_id, quiz_id, type, content, answer, tags, ease_factor, interval, repetitions, next_review_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, ?, ?, ?)`
		).bind(
			id, userId, quizId,
			q.type,
			JSON.stringify(q.content),
			JSON.stringify(q.answer),
			q.tags ? JSON.stringify(q.tags) : null,
			now, now, now,
		);
	});

	const validStatements = statements.filter((s) => s !== null);

	if (validStatements.length === 0) {
		return c.json({ error: 'No valid questions in batch (each needs type, content, answer)' }, 400);
	}

	await c.env.DB.batch(validStatements);

	// 更新 quiz 状态为 completed，同步更新 session
	await c.env.DB.batch([
		c.env.DB.prepare(`UPDATE quizzes SET status = 'completed', updated_at = ? WHERE id = ?`).bind(now, quizId),
		c.env.DB.prepare(`UPDATE quiz_sessions SET status = 'completed', completed_at = ? WHERE id = ?`).bind(now, sessionId),
	]);

	return c.json({
		data: {
			inserted: validStatements.length,
			quizId,
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
 *   - due: "true" 只返回到期题目
 *   - type: 按题型过滤
 *   - page / limit: 分页
 */
quiz.get('/questions', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const quizId = c.req.query('quizId');
	const tagsParam = c.req.query('tags');
	const due = c.req.query('due') === 'true';
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

	if (due) {
		conditions.push('next_review_at <= ?');
		params.push(new Date().toISOString());
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
		c.env.DB.prepare(`SELECT * FROM questions WHERE ${whereClause} ORDER BY next_review_at ASC LIMIT ? OFFSET ?`)
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
 * 批量提交作答记录 + 更新调度状态（需要用户 JWT）
 */
quiz.post('/answers', authMiddleware, async (c) => {
	const userId = c.get('userId');

	let body: {
		answers: Array<{
			questionId: string;
			isCorrect: boolean;
			userAnswer?: unknown;
			newSchedule: {
				easeFactor: number;
				interval: number;
				repetitions: number;
				nextReviewAt: string;
			};
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
		if (!a.questionId || typeof a.isCorrect !== 'boolean' || !a.newSchedule) {
			continue;
		}

		const answerId = crypto.randomUUID();

		statements.push(
			c.env.DB.prepare(
				`INSERT INTO answer_records (id, user_id, question_id, is_correct, user_answer, answered_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).bind(answerId, userId, a.questionId, a.isCorrect ? 1 : 0, a.userAnswer ? JSON.stringify(a.userAnswer) : null, now)
		);

		statements.push(
			c.env.DB.prepare(
				`UPDATE questions
				 SET ease_factor = ?, interval = ?, repetitions = ?, next_review_at = ?, last_reviewed_at = ?, updated_at = ?
				 WHERE id = ? AND user_id = ?`
			).bind(
				a.newSchedule.easeFactor,
				a.newSchedule.interval,
				a.newSchedule.repetitions,
				a.newSchedule.nextReviewAt,
				now, now,
				a.questionId, userId,
			)
		);
	}

	if (statements.length === 0) {
		return c.json({ error: 'No valid answers in batch' }, 400);
	}

	await c.env.DB.batch(statements);

	return c.json({ data: { recorded: statements.length / 2 } }, 201);
});

export { quiz };
