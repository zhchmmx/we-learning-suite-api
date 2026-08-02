import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { authMiddleware } from './auth';
import { files } from './routes/files';

const app = new Hono<AppEnv>();

// 全局 CORS（桌面客户端可能需要）
app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization', 'X-File-Name', 'X-File-Path'],
	})
);

// 健康检查（无需鉴权）
app.get('/health', (c) => {
	return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 所有 /api/files 路由需要鉴权
app.use('/api/files/*', authMiddleware);
app.route('/api/files', files);

// 404 兜底
app.notFound((c) => {
	return c.json({ error: 'Not found' }, 404);
});

// 全局错误处理
app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return c.json({ error: 'Internal server error' }, 500);
});

export default app;
