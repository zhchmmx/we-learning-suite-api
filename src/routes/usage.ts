import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../auth';

/**
 * 用量路由：用户查看自己的月度 AI 用量（Cost 口径）。
 * 实际聚合在 AI Worker 完成（查 AI Gateway 日志），这里只做鉴权 + 透传；
 * userId 取自 JWT 认证结果，客户端无法查询他人。
 */
const usage = new Hono<AppEnv>();

/**
 * GET /usage?ym=YYYY-MM（可选，默认本月，北京时间自然月）
 * 返回：{ data: { month, requests, cost(USD), tokensIn, tokensOut } }
 */
usage.get('/', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const ym = c.req.query('ym');

	const qs = new URLSearchParams({ userId });
	if (ym) qs.set('ym', ym);

	let res: Response;
	try {
		// 翻页聚合可能多轮外呼，超时给足
		res = await c.env.AI_WORKER.fetch(`http://we-learning-suite-ai/api/usage?${qs.toString()}`, {
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		return c.json({ error: '用量服务暂时不可用' }, 502);
	}

	return new Response(res.body, {
		status: res.status,
		headers: { 'Content-Type': 'application/json' },
	});
});

export { usage };
