import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as Sentry from '@sentry/cloudflare';
import type { AppEnv } from './types';
import { authMiddleware } from './auth';
import { files } from './routes/files';
import { quiz } from './routes/quiz';
import { usage } from './routes/usage';

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

// AI 用量路由（JWT 鉴权，聚合在 AI Worker 完成）
app.route('/usage', usage);

// 404 兜底
app.notFound((c) => {
	return c.json({ error: 'Not found' }, 404);
});

// 全局错误处理
// 说明：Sentry 的 Hono 集成（@sentry/cloudflare）默认启用，会自动捕获 onError 中抛出的异常并上报；
// 这里的 console.error 仅用于本地日志，与 Sentry 并存无冲突。
app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return c.json({ error: 'Internal server error' }, 500);
});

// 用 Sentry.withSentry 包裹 Hono 应用导出，尽早初始化 SDK。
// DSN 从环境变量读取：本地放 .dev.vars，生产用 `wrangler secret put SENTRY_DSN`。
// tracesSampleRate 上线稳定后建议下调（如 0.1）以控制配额。
export default Sentry.withSentry(
	(env): Sentry.CloudflareOptions => ({
		dsn: env.SENTRY_DSN,
		tracesSampleRate: 1.0,
	}),
	app,
);
