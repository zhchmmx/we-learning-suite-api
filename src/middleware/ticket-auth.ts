import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

interface QuizSession {
	id: string;
	user_id: string;
	source_file_id: string;
	status: string;
	expires_at: string;
	created_at: string;
	completed_at: string | null;
}

/**
 * Ticket 认证中间件
 *
 * 用于 AI Worker 调用本 Worker 时的身份验证。
 * 从 X-Quiz-Ticket header 中提取 ticket，
 * 查询 quiz_sessions 表验证有效性（存在、未过期、状态为 pending 或 processing）。
 * 验证通过后将 userId 和 sessionId 写入上下文。
 */
export const ticketAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const ticket = c.req.header('X-Quiz-Ticket');

	if (!ticket) {
		return c.json({ error: 'Missing X-Quiz-Ticket header' }, 401);
	}

	const session = await c.env.DB.prepare(`SELECT * FROM quiz_sessions WHERE id = ?`).bind(ticket).first<QuizSession>();

	if (!session) {
		return c.json({ error: 'Invalid ticket' }, 401);
	}

	// 检查过期
	if (new Date(session.expires_at) < new Date()) {
		return c.json({ error: 'Ticket has expired' }, 401);
	}

	// 检查状态：只有 pending 和 processing 允许操作
	if (session.status !== 'pending' && session.status !== 'processing') {
		return c.json({ error: `Ticket is already ${session.status}` }, 403);
	}

	// 将 session 信息写入上下文
	c.set('userId', session.user_id);
	c.set('sessionId', session.id);

	await next();
});
