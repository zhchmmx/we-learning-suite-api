import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

interface SubscriptionResponse {
	subscription?: {
		quotaLimit?: number | null;
		[key: string]: unknown;
	};
}

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

	// 1. 调 Appwrite Function 拿 quotaLimit
	let quotaLimit: number;
	try {
		const functionId = c.env.APPWRITE_FUNCTION_ID;
		const fnBase = `${c.env.APPWRITE_ENDPOINT}/functions/${functionId}/executions`;
		const fnHeaders = {
			'Content-Type': 'application/json',
			'X-Appwrite-Project': c.env.APPWRITE_PROJECT_ID,
			'X-Appwrite-JWT': jwt,
		};

		const res = await fetch(fnBase, {
			method: 'POST',
			headers: fnHeaders,
			body: JSON.stringify({ path: '/subscription/me', method: 'GET' }),
		});

		if (!res.ok) {
			console.error(`Quota check: subscription fetch failed (${res.status})`);
			quotaLimit = 0.5; // 兜底 free 额度
		} else {
			const data = (await res.json()) as { responseBody?: string };
			const parsed = JSON.parse(data.responseBody || '{}') as SubscriptionResponse;

			if (parsed.subscription) {
				quotaLimit = parsed.subscription.quotaLimit ?? 0.5;
			} else {
				// 用户无任何订阅记录 → 自动初始化免费订阅
				console.log(`Quota check: no subscription for ${userId}, auto-init free`);
				const initRes = await fetch(fnBase, {
					method: 'POST',
					headers: fnHeaders,
					body: JSON.stringify({ path: '/subscription/init-free', method: 'POST' }),
				});

				if (initRes.ok) {
					const initData = (await initRes.json()) as { responseBody?: string };
					const initParsed = JSON.parse(initData.responseBody || '{}') as SubscriptionResponse;
					quotaLimit = initParsed.subscription?.quotaLimit ?? 0.5;
				} else {
					console.error(`Quota check: init-free failed (${initRes.status})`);
					quotaLimit = 0.5;
				}
			}
		}
	} catch (err) {
		console.error('Quota check: subscription error:', err);
		quotaLimit = 0.5;
	}

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
