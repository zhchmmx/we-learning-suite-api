import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './types';

/**
 * Appwrite JWT 鉴权中间件
 *
 * 从 Authorization: Bearer <jwt> 中提取 token，
 * 调用 Appwrite REST API 验证 token 有效性并获取用户信息。
 * 验证通过后将 userId 写入上下文变量。
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const authHeader = c.req.header('Authorization');

	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return c.json({ error: 'Missing or invalid Authorization header. Expected: Bearer <JWT>' }, 401);
	}

	const jwt = authHeader.slice(7);

	if (!jwt) {
		return c.json({ error: 'Empty token' }, 401);
	}

	try {
		// 调用 Appwrite 的 /account 接口验证 JWT
		// 如果 JWT 有效，会返回用户信息；无效则返回 401
		const response = await fetch(`${c.env.APPWRITE_ENDPOINT}/account`, {
			method: 'GET',
			headers: {
				'X-Appwrite-Project': c.env.APPWRITE_PROJECT_ID,
				'X-Appwrite-JWT': jwt,
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			return c.json({ error: 'Authentication failed. Token is invalid or expired.' }, 401);
		}

		const user = (await response.json()) as { $id: string; email: string; name: string };

		// 将用户 ID 存入上下文，后续路由可通过 c.get('userId') 获取
		c.set('userId', user.$id);

		await next();
	} catch (err) {
		console.error('Auth verification error:', err);
		return c.json({ error: 'Authentication service unavailable' }, 503);
	}
});
