import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { authMiddleware } from './auth';
import { files } from './routes/files';
import { quiz } from './routes/quiz';

const app = new Hono<AppEnv>();

// 全局 CORS（桌面客户端可能需要）
app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization', 'X-File-Name', 'X-File-Path', 'X-Quiz-Ticket'],
	})
);

// 健康检查（无需鉴权）
app.get('/health', (c) => {
	return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 文件管理路由（鉴权在各路由内部处理）
app.use('/api/files/*', authMiddleware);
app.route('/api/files', files);

// We Quiz 路由（鉴权在各路由内部处理：JWT 或 ticket）
app.route('/api/quiz', quiz);

// 404 兜底
app.notFound((c) => {
	return c.json({ error: 'Not found' }, 404);
});

// 全局错误处理（临时暴露 detail 用于调试，修完后改回去）
app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return c.json({ error: 'Internal server error', detail: err.message }, 500);
});

export default app;
