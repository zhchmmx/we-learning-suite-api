import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';
import { fetchSubscription } from '../services/appwrite';

interface UsageResponse {
	data?: {
		cost?: number;
		[key: string]: unknown;
	};
}

/**
 * 额度检查中间件
 *
 * 在触发 AI 生成之前检查用户当月用量是否超过 quotaLimit：
 * 1. 调 Appwrite Function 拿 subscription.quotaLimit
 *    - 若用户无任何订阅记录，自动调 init-free 创建免费订阅
 * 2. 调 AI Worker /api/usage 拿当月 cost
 * 3. 超额返回 429 QUOTA_EXCEEDED，否则放行
 */
export const quotaCheckMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const userId = c.get('userId');
	const jwt = c.req.header('Authorization')?.replace('Bearer ', '');

	if (!userId || !jwt) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	// 1. 调 Appwrite Function 拿 quotaLimit（无订阅时自动 init-free；失败回退 free 额度）
	const subscription = await fetchSubscription(c);
	const quotaLimit = subscription?.quotaLimit ?? 0.5;

	// 2. 调 AI Worker 拿当月用量
	let currentCost: number;
	try {
		const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
		const res = await c.env.AI_WORKER.fetch(
			`http://we-learning-suite-ai/api/usage?userId=${encodeURIComponent(userId)}&ym=${ym}`,
			{ signal: AbortSignal.timeout(10_000) }
		);

		if (!res.ok) {
			console.error(`Quota check: usage fetch failed (${res.status})`);
			return await next();
		}

		const data = (await res.json()) as UsageResponse;
		currentCost = data.data?.cost ?? 0;
	} catch (err) {
		console.error('Quota check: usage error:', err);
		return await next();
	}

	// 3. 对比
	if (currentCost >= quotaLimit) {
		return c.json(
			{
				error: {
					code: 'QUOTA_EXCEEDED',
					message: 'Monthly AI usage quota exceeded',
					quotaLimit,
					currentUsage: currentCost,
				},
			},
			429
		);
	}

	await next();
});
