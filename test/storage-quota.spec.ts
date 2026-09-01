import { env, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
	DEFAULT_FREE_STORAGE_LIMIT_BYTES,
	evaluateStorageQuota,
	getStorageUsageBytes,
} from '../src/services/storage-quota';
import type { StorageQuotaResponse } from '../src/types';

// ===== fetchMock：拦截 Appwrite 外呼（JWT 鉴权 + 订阅查询） =====

const APPWRITE_ORIGIN = 'https://sgp.cloud.appwrite.io';
const EXECUTIONS_PATH = '/v1/functions/6a784dd9002e0069cf39/executions';

/** 模拟 Appwrite /account 鉴权成功（authMiddleware 外呼） */
function mockAuth(userId = 'user-1') {
	fetchMock
		.get(APPWRITE_ORIGIN)
		.intercept({ method: 'GET', path: '/v1/account' })
		.reply(200, JSON.stringify({ $id: userId, email: 'test@example.com', name: 'Test' }));
}

/** 模拟 /subscription/me 返回订阅记录（subscription 为 null 时走 init-free 失败 → 回退） */
function mockSubscriptionMe(subscription: Record<string, unknown>) {
	fetchMock
		.get(APPWRITE_ORIGIN)
		.intercept({ method: 'POST', path: EXECUTIONS_PATH })
		.reply(200, JSON.stringify({ responseBody: JSON.stringify({ subscription }) }));
}

/** 模拟 Appwrite Function 故障（HTTP 500 → fetchSubscription 返回 null） */
function mockSubscriptionMeFailure() {
	fetchMock
		.get(APPWRITE_ORIGIN)
		.intercept({ method: 'POST', path: EXECUTIONS_PATH })
		.reply(500, 'internal error');
}

// ===== D1 测试数据 =====

/** 与 migrations 最终结构一致的 files 表（0001 + 0003 + 0004） */
const FILES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS files (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	path TEXT NOT NULL DEFAULT '/',
	r2_key TEXT NOT NULL,
	size INTEGER NOT NULL DEFAULT 0,
	mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	thumbnail_key TEXT,
	status TEXT NOT NULL DEFAULT 'confirmed',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

async function seedFile(opts: { id: string; userId: string; size: number; status?: 'confirmed' | 'pending' }) {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO files (id, user_id, name, path, r2_key, size, mime_type, status, created_at, updated_at)
		 VALUES (?, ?, ?, '/', ?, ?, 'text/plain', ?, ?, ?)`
	)
		.bind(opts.id, opts.userId, `${opts.id}.txt`, `${opts.userId}/${opts.id}`, opts.size, opts.status ?? 'confirmed', now, now)
		.run();
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(async () => {
	await env.DB.prepare(FILES_TABLE_SQL).run();
	await env.DB.prepare('DELETE FROM files').run();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

// ===== 纯函数：evaluateStorageQuota =====

describe('evaluateStorageQuota', () => {
	it('未达上限放行', () => {
		expect(evaluateStorageQuota(1000, 900, 99)).toBe(true);
		expect(evaluateStorageQuota(1000, 0, 999)).toBe(true);
	});

	it('恰好用满上限允许（放得下就放行）', () => {
		expect(evaluateStorageQuota(1000, 900, 100)).toBe(true);
		expect(evaluateStorageQuota(1000, 0, 1000)).toBe(true);
	});

	it('超出一字节也拒绝', () => {
		expect(evaluateStorageQuota(1000, 900, 101)).toBe(false);
		expect(evaluateStorageQuota(1000, 1000, 1)).toBe(false);
	});
});

// ===== 用量统计：getStorageUsageBytes =====

describe('getStorageUsageBytes', () => {
	it('SUM 统计 confirmed 与 pending，且只算当前用户', async () => {
		await seedFile({ id: 'f1', userId: 'user-1', size: 100, status: 'confirmed' });
		await seedFile({ id: 'f2', userId: 'user-1', size: 50, status: 'pending' });
		await seedFile({ id: 'f3', userId: 'user-2', size: 999 });

		expect(await getStorageUsageBytes(env.DB, 'user-1')).toBe(150);
	});

	it('无文件时返回 0', async () => {
		expect(await getStorageUsageBytes(env.DB, 'user-1')).toBe(0);
	});
});

// ===== 查询端点：GET /api/files/quota =====

describe('GET /api/files/quota', () => {
	it('返回订阅上限、用量与剩余', async () => {
		mockAuth();
		mockSubscriptionMe({ quotaLimit: 0.5, storageLimit: 1_048_576 });
		await seedFile({ id: 'f1', userId: 'user-1', size: 409_600 });

		const res = await SELF.fetch('https://example.com/api/files/quota', {
			headers: { Authorization: 'Bearer test-jwt' },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: StorageQuotaResponse };
		expect(body.data.usedBytes).toBe(409_600);
		expect(body.data.quotaLimitBytes).toBe(1_048_576);
		expect(body.data.remainingBytes).toBe(1_048_576 - 409_600);
	});

	it('订阅缺 storageLimit 字段时回退 500 MB 默认值', async () => {
		mockAuth();
		mockSubscriptionMe({ quotaLimit: 0.5 });
		await seedFile({ id: 'f1', userId: 'user-1', size: 1024 });

		const res = await SELF.fetch('https://example.com/api/files/quota', {
			headers: { Authorization: 'Bearer test-jwt' },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: StorageQuotaResponse };
		expect(body.data.quotaLimitBytes).toBe(DEFAULT_FREE_STORAGE_LIMIT_BYTES);
		expect(body.data.usedBytes).toBe(1024);
		expect(body.data.remainingBytes).toBe(DEFAULT_FREE_STORAGE_LIMIT_BYTES - 1024);
	});

	it('Appwrite 故障时上限仍回退默认值（fail-safe，检查不失效）', async () => {
		mockAuth();
		mockSubscriptionMeFailure();

		const res = await SELF.fetch('https://example.com/api/files/quota', {
			headers: { Authorization: 'Bearer test-jwt' },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: StorageQuotaResponse };
		expect(body.data.quotaLimitBytes).toBe(DEFAULT_FREE_STORAGE_LIMIT_BYTES);
	});
});

// ===== 上传拦截：POST /api/files/upload =====

describe('POST /api/files/upload 存储配额', () => {
	it('超出配额时返回 429 STORAGE_QUOTA_EXCEEDED，且不写 R2 / D1', async () => {
		mockAuth();
		mockSubscriptionMe({ quotaLimit: 0.5, storageLimit: 1000 });

		const form = new FormData();
		form.append('file', new File(['x'.repeat(1001)], 'big.txt', { type: 'text/plain' }));

		const res = await SELF.fetch('https://example.com/api/files/upload', {
			method: 'POST',
			headers: { Authorization: 'Bearer test-jwt' },
			body: form,
		});

		expect(res.status).toBe(429);
		const body = (await res.json()) as {
			error: { code: string; message: string; quotaLimitBytes: number; currentUsageBytes: number; requestedBytes: number };
		};
		expect(body.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
		expect(body.error.quotaLimitBytes).toBe(1000);
		expect(body.error.currentUsageBytes).toBe(0);
		expect(body.error.requestedBytes).toBe(1001);

		// 拒绝发生在写入之前
		const r2Objects = await env.R2_BUCKET.list();
		expect(r2Objects.objects.length).toBe(0);
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it('配额内上传正常成功（201），用量随即反映到 GET /quota', async () => {
		mockAuth();
		mockSubscriptionMe({ quotaLimit: 0.5, storageLimit: 1000 });

		const form = new FormData();
		form.append('file', new File(['x'.repeat(10)], 'small.txt', { type: 'text/plain' }));

		const res = await SELF.fetch('https://example.com/api/files/upload', {
			method: 'POST',
			headers: { Authorization: 'Bearer test-jwt' },
			body: form,
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: { size: number } };
		expect(body.data.size).toBe(10);

		// 成功上传后重新 mock 一次订阅（GET /quota 会再查一次 Appwrite）
		mockAuth();
		mockSubscriptionMe({ quotaLimit: 0.5, storageLimit: 1000 });
		const quotaRes = await SELF.fetch('https://example.com/api/files/quota', {
			headers: { Authorization: 'Bearer test-jwt' },
		});
		const quotaBody = (await quotaRes.json()) as { data: StorageQuotaResponse };
		expect(quotaBody.data.usedBytes).toBe(10);
		expect(quotaBody.data.remainingBytes).toBe(990);
	});
});

// ===== 上传拦截：POST /api/files/presign/upload =====

describe('POST /api/files/presign/upload 存储配额', () => {
	it('声明大小超出配额时返回 429，且不写 pending 记录', async () => {
		mockAuth();
		mockSubscriptionMe({ quotaLimit: 0.5, storageLimit: 1000 });

		const res = await SELF.fetch('https://example.com/api/files/presign/upload', {
			method: 'POST',
			headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'big.txt', size: 2000, mimeType: 'text/plain' }),
		});

		expect(res.status).toBe(429);
		const body = (await res.json()) as {
			error: { code: string; quotaLimitBytes: number; currentUsageBytes: number; requestedBytes: number };
		};
		expect(body.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
		expect(body.error.quotaLimitBytes).toBe(1000);
		expect(body.error.requestedBytes).toBe(2000);

		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>();
		expect(count?.n).toBe(0);
	});
});
