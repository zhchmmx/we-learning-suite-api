import type { Context } from 'hono';
import type { AppEnv } from '../types';

/** 订阅记录（Appwrite Function /subscription/me 返回的 subscription 对象） */
export interface SubscriptionInfo {
	/** AI 配额：月度额度上限（USD/月） */
	quotaLimit?: number | null;
	/** 存储配额：R2 存储额度上限（字节） */
	storageLimit?: number | null;
	[key: string]: unknown;
}

interface SubscriptionResponse {
	subscription?: SubscriptionInfo;
}

/**
 * 调 Appwrite Function 获取当前用户的订阅信息（AI 配额与存储配额共享）。
 *
 * 1. 通过 Function executions 代理调用 /subscription/me
 * 2. 若用户无任何订阅记录，自动代理 /subscription/init-free 创建免费订阅
 *
 * 任何失败（鉴权信息缺失、HTTP 错误、网络异常）返回 null，
 * 由调用方决定各自的回退值（AI 配额回退 0.5 USD，存储配额回退 500 MB）。
 */
export async function fetchSubscription(c: Context<AppEnv>): Promise<SubscriptionInfo | null> {
	const userId = c.get('userId');
	const jwt = c.req.header('Authorization')?.replace('Bearer ', '');

	if (!userId || !jwt) {
		return null;
	}

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
			console.error(`Subscription fetch failed (${res.status})`);
			return null;
		}

		const data = (await res.json()) as { responseBody?: string };
		const parsed = JSON.parse(data.responseBody || '{}') as SubscriptionResponse;

		if (parsed.subscription) {
			return parsed.subscription;
		}

		// 用户无任何订阅记录 → 自动初始化免费订阅
		console.log(`No subscription for ${userId}, auto-init free`);
		const initRes = await fetch(fnBase, {
			method: 'POST',
			headers: fnHeaders,
			body: JSON.stringify({ path: '/subscription/init-free', method: 'POST' }),
		});

		if (initRes.ok) {
			const initData = (await initRes.json()) as { responseBody?: string };
			const initParsed = JSON.parse(initData.responseBody || '{}') as SubscriptionResponse;
			return initParsed.subscription ?? null;
		}

		console.error(`Init-free failed (${initRes.status})`);
		return null;
	} catch (err) {
		console.error('Subscription fetch error:', err);
		return null;
	}
}
