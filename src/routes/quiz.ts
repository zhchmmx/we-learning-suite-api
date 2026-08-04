import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../auth';
import { ticketAuthMiddleware } from '../middleware/ticket-auth';
import { generatePresignedUrl } from '../services/presign';
import { isAllowedUploadMime } from './files';

const quiz = new Hono<AppEnv>();

const BUCKET_NAME = 'we-learning-suite';
const TICKET_TTL_SECONDS = 1800; // 30 分钟
const MAX_BATCH_SIZE = 500;

// ===== 类型 =====

interface QuestionRecord {
	id: string;
	user_id: string;
	source_file_id: string | null;
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
	source_file_id: string;
	status: string;
	expires_at: string;
	created_at: string;
	completed_at: string | null;
}

// ===== Sessions 路由 =====

/**
 * POST /sessions
 * 创建 quiz session 并服务端触发 AI Worker（需要用户 JWT）
 * 客户端只需提供 sourceFileId，拿到的响应只有 sessionId + 状态，
 * ticket 和 downloadUrl 由服务端传给 AI Worker，客户端全程接触不到 AI Worker
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

	// 只允许对文本格式的文档出题（服务器只接受文本上传，历史遗留的 PDF 等无法生成）
	if (!isAllowedUploadMime(file.mime_type)) {
		return c.json({
			error: '该文档不是文本格式，无法生成题目。请将其转换为文本（txt/md）后重新上传',
		}, 415);
	}

	// 生成 ticket
	const ticketId = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000);

	await c.env.DB.prepare(
		`INSERT INTO quiz_sessions (id, user_id, source_file_id, status, expires_at, created_at)
		 VALUES (?, ?, ?, 'pending', ?, ?)`
	)
		.bind(ticketId, userId, body.sourceFileId, expiresAt.toISOString(), now.toISOString())
		.run();

	// 生成文档预签名下载 URL
	const downloadUrl = await generatePresignedUrl({
		accountId: c.env.CLOUDFLARE_ACCOUNT_ID,
		accessKeyId: c.env.R2_ACCESS_KEY_ID,
		secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
		bucket: BUCKET_NAME,
		key: file.r2_key,
		method: 'GET',
		expiresIn: TICKET_TTL_SECONDS,
	});

	// 服务端触发 AI Worker（Service Binding 内部直连，ticket + downloadUrl 不走公网）
	let triggerOk = false;
	try {
		const triggerRes = await c.env.AI_WORKER.fetch('http://we-learning-suite-ai/api/quiz/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ticket: ticketId, downloadUrls: [downloadUrl] }),
			signal: AbortSignal.timeout(15000),
		});
		triggerOk = triggerRes.ok;
	} catch {
		// 网络错误 / 超时
		triggerOk = false;
	}

	if (!triggerOk) {
		// 触发失败：清理刚创建的 session，不留垃圾数据
		await c.env.DB.prepare(`DELETE FROM quiz_sessions WHERE id = ?`).bind(ticketId).run();
		return c.json({ error: 'AI 服务暂时不可用，请稍后重试' }, 503);
	}

	return c.json({
		data: {
			sessionId: ticketId,
			sourceFileName: file.name,
			status: 'processing',
			expiresIn: TICKET_TTL_SECONDS,
		},
	}, 201);
});

/**
 * GET /sessions/:id
 * 查询 session 状态（需要用户 JWT）
 */
quiz.get('/sessions/:id', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const sessionId = c.req.param('id');

	const session = await c.env.DB.prepare(`SELECT * FROM quiz_sessions WHERE id = ? AND user_id = ?`)
		.bind(sessionId, userId)
		.first<QuizSessionRecord>();

	if (!session) {
		return c.json({ error: 'Session not found' }, 404);
	}

	return c.json({
		data: {
			id: session.id,
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
 * Body: { "status": "processing" | "completed" | "failed" }
 */
quiz.patch('/sessions/:id/status', ticketAuthMiddleware, async (c) => {
	const sessionId = c.req.param('id');
	const contextSessionId = c.get('sessionId');

	// ticket 只能操作自己对应的 session
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

	await c.env.DB.prepare(`UPDATE quiz_sessions SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`)
		.bind(body.status, completedAt, sessionId)
		.run();

	return c.json({ data: { id: sessionId, status: body.status } });
});

// ===== OCR 路由 =====

/**
 * POST /ocr
 * 图片转文字（需要用户 JWT）。
 * 客户端上传前把扫描件 PDF 的渲染图 / 图片文件发到这里，
 * 本 Worker 通过 Service Binding 内部直连 AI Worker 的 /api/ocr，再把结果原样流回。
 * AI Worker 没有公网入口，客户端（以及任何外部请求）物理上接触不到它。
 *
 * Body: { images: [{ data: base64, mimeType: "image/jpeg"|"image/png"|"image/webp" }] }（最多 15 张）
 * 返回：{ data: { text } }
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
			// OCR 是同步等待模型转录，多图时可能耗时几分钟（Worker 请求无墙钟限制）
			signal: AbortSignal.timeout(5 * 60 * 1000),
		});
	} catch {
		return c.json({ error: 'OCR 服务暂时不可用，请稍后重试' }, 502);
	}

	// AI Worker 返回的都是 JSON（成功或错误），状态码原样透传
	return new Response(res.body, {
		status: res.status,
		headers: { 'Content-Type': 'application/json' },
	});
});

// ===== Questions 路由 =====

/**
 * POST /questions/batch
 * AI Worker 批量上传题目（需要 ticket 认证）
 * Body: { "questions": [{ "type", "content", "answer", "tags"? }] }
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

	// 获取 session 的 source_file_id
	const session = await c.env.DB.prepare(`SELECT source_file_id FROM quiz_sessions WHERE id = ?`)
		.bind(sessionId)
		.first<{ source_file_id: string }>();

	const sourceFileId = session?.source_file_id || null;
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
			`INSERT INTO questions (id, user_id, source_file_id, type, content, answer, tags, ease_factor, interval, repetitions, next_review_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, ?, ?, ?)`
		).bind(
			id,
			userId,
			sourceFileId,
			q.type,
			JSON.stringify(q.content),
			JSON.stringify(q.answer),
			q.tags ? JSON.stringify(q.tags) : null,
			now, // next_review_at = now（立即可复习）
			now,
			now
		);
	});

	// 过滤无效条目
	const validStatements = statements.filter((s) => s !== null);

	if (validStatements.length === 0) {
		return c.json({ error: 'No valid questions in batch (each needs type, content, answer)' }, 400);
	}

	// D1 batch 执行
	await c.env.DB.batch(validStatements);

	// 更新 session 状态为 completed
	await c.env.DB.prepare(`UPDATE quiz_sessions SET status = 'completed', completed_at = ? WHERE id = ?`)
		.bind(now, sessionId)
		.run();

	return c.json({
		data: {
			inserted: validStatements.length,
			questionIds: insertedIds.slice(0, validStatements.length),
			sessionId,
		},
	}, 201);
});

/**
 * GET /questions
 * 获取题目列表（需要用户 JWT）
 *
 * 查询参数：
 *   - sourceFileId: 按来源文档过滤
 *   - tags: 逗号分隔的标签过滤（匹配任一）
 *   - due: "true" 只返回到期题目（next_review_at <= now）
 *   - type: 按题型过滤
 *   - page: 页码（默认 1）
 *   - limit: 每页数量（默认 50，最大 200）
 */
quiz.get('/questions', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const sourceFileId = c.req.query('sourceFileId');
	const tagsParam = c.req.query('tags');
	const due = c.req.query('due') === 'true';
	const type = c.req.query('type');
	const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
	const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
	const offset = (page - 1) * limit;

	const conditions: string[] = ['user_id = ?'];
	const params: (string | number)[] = [userId];

	if (sourceFileId) {
		conditions.push('source_file_id = ?');
		params.push(sourceFileId);
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
		// tags 存为 JSON 数组，用 LIKE 模糊匹配任一标签
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

	const questions = (questionsResult.results || []).map((q) => ({
		id: q.id,
		sourceFileId: q.source_file_id,
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
	}));

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

	return c.json({
		data: {
			id: q.id,
			sourceFileId: q.source_file_id,
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
		},
	});
});

/**
 * DELETE /questions/:id
 * 删除题目（需要用户 JWT）
 * 同时删除关联的作答记录
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
 *
 * Body: {
 *   "answers": [{
 *     "questionId": string,
 *     "isCorrect": boolean,
 *     "userAnswer"?: any,
 *     "newSchedule": {
 *       "easeFactor": number,
 *       "interval": number,
 *       "repetitions": number,
 *       "nextReviewAt": string (ISO)
 *     }
 *   }]
 * }
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

		// 插入作答记录
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO answer_records (id, user_id, question_id, is_correct, user_answer, answered_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).bind(answerId, userId, a.questionId, a.isCorrect ? 1 : 0, a.userAnswer ? JSON.stringify(a.userAnswer) : null, now)
		);

		// 更新题目调度状态
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
				now,
				now,
				a.questionId,
				userId
			)
		);
	}

	if (statements.length === 0) {
		return c.json({ error: 'No valid answers in batch' }, 400);
	}

	await c.env.DB.batch(statements);

	return c.json({
		data: {
			recorded: statements.length / 2,
		},
	}, 201);
});

export { quiz };
