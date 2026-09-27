import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../auth';
import { fetchSubscription } from '../services/appwrite';

/** 免费档默认 AI 配额（USD/月）：订阅缺失或 Appwrite 调用失败时回退，与 quota-check 中间件一致 */
const DEFAULT_FREE_AI_QUOTA_USD = 0.5;

/** 四舍五入到 1 位小数（百分比对外统一精度，客户端不再自行格式化） */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 由原始用量（内部 USD 口径）与配额上限计算对外百分比（唯一权威源）。
 * clamp 到 0~100，统一保留 1 位小数；quotaLimit 非法（0/NaN/负数）时按 0 处理。
 */
export function computeUsagePercent(
	cost: number,
	quotaLimit: number
): { usagePercent: number; remainingPercent: number } {
	const validLimit = Number.isFinite(quotaLimit) && quotaLimit > 0;
	const usagePercent = round1(validLimit ? Math.min((cost / quotaLimit) * 100, 100) : 0);
	const remainingPercent = round1(Math.max(100 - usagePercent, 0));
	return { usagePercent, remainingPercent };
}

/**
 * 用量路由：用户查看自己的月度 AI 用量（Cost 口径）。
 * 实际聚合在 AI Worker 完成（查 AI Gateway 日志），这里只做鉴权 + 透传；
 * userId 取自 JWT 认证结果，客户端无法查询他人。
 */
const usage = new Hono<AppEnv>();

/**
 * GET /usage?ym=YYYY-MM（可选，默认本月，北京时间自然月）
 * 返回：{ data: { month, requests, cost(USD), tokensIn, tokensOut } }
 * 兼容旧客户端：保留美元口径，字段结构不变。
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

/** AI Worker /api/usage 原始返回结构 */
interface RawUsageData {
	month?: string;
	requests?: number;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
}

/**
 * GET /usage/v2?ym=YYYY-MM（可选，默认本月，北京时间自然月）
 * 返回：{ data: { month, requests, tokensIn, tokensOut, usagePercent, remainingPercent } }
 *
 * usagePercent / remainingPercent 由后端统一计算（唯一权威源，不对外暴露美元），
 * 所有客户端直接消费该值，避免各自计算导致展示不一致。
 */
usage.get('/v2', authMiddleware, async (c) => {
	const userId = c.get('userId');
	const ym = c.req.query('ym');

	const qs = new URLSearchParams({ userId });
	if (ym) qs.set('ym', ym);

	// 1. 调 AI Worker 拿当月原始用量（内部口径仍为 USD，仅用于计算，不对外返回）
	let res: Response;
	try {
		res = await c.env.AI_WORKER.fetch(`http://we-learning-suite-ai/api/usage?${qs.toString()}`, {
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		return c.json({ error: '用量服务暂时不可用' }, 502);
	}

	if (!res.ok) {
		return new Response(res.body, {
			status: res.status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const raw = (await res.json()) as { data?: RawUsageData };
	const d = raw.data ?? {};
	const cost = Number(d.cost) || 0;

	// 2. 拿订阅配额上限（无订阅自动 init-free；失败回退免费额度）
	const subscription = await fetchSubscription(c);
	const quotaLimit = subscription?.quotaLimit ?? DEFAULT_FREE_AI_QUOTA_USD;

	// 3. 计算百分比（clamp 0~100，统一 1 位小数）
	const { usagePercent, remainingPercent } = computeUsagePercent(cost, quotaLimit);

	return c.json({
		data: {
			month: d.month ?? null,
			requests: d.requests ?? 0,
			tokensIn: d.tokensIn ?? 0,
			tokensOut: d.tokensOut ?? 0,
			usagePercent,
			remainingPercent,
		},
	});
});

export { usage };
