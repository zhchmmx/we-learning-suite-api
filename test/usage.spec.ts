import { env, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { computeUsagePercent } from '../src/routes/usage';

// ===== fetchMock：拦截 Appwrite 外呼（JWT 鉴权） =====

const APPWRITE_ORIGIN = 'https://sgp.cloud.appwrite.io';

/** 模拟 Appwrite /account 鉴权成功（authMiddleware 外呼） */
function mockAuth(userId = 'user-1') {
	fetchMock
		.get(APPWRITE_ORIGIN)
		.intercept({ method: 'GET', path: '/v1/account' })
		.reply(200, JSON.stringify({ $id: userId, email: 'test@example.com', name: 'Test' }));
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

// ===== 纯函数：computeUsagePercent（百分比计算的唯一权威源） =====

describe('computeUsagePercent', () => {
	it('免费档：0.25 USD / 0.5 USD = 50%', () => {
		expect(computeUsagePercent(0.25, 0.5)).toEqual({ usagePercent: 50, remainingPercent: 50 });
	});

	it('付费档：0.5 USD / 5 USD = 10%', () => {
		expect(computeUsagePercent(0.5, 5)).toEqual({ usagePercent: 10, remainingPercent: 90 });
	});

	it('完全用满 = 100% / 0%', () => {
		expect(computeUsagePercent(5, 5)).toEqual({ usagePercent: 100, remainingPercent: 0 });
	});

	it('超出上限 clamp 到 100%', () => {
		expect(computeUsagePercent(7, 5)).toEqual({ usagePercent: 100, remainingPercent: 0 });
	});

	it('统一保留 1 位小数（3.34% → 3.3）', () => {
		expect(computeUsagePercent(0.0167, 0.5)).toEqual({ usagePercent: 3.3, remainingPercent: 96.7 });
	});

	it('quotaLimit 为 0 / 非法值时不除零，按 0% 处理', () => {
		expect(computeUsagePercent(0.1, 0)).toEqual({ usagePercent: 0, remainingPercent: 100 });
		expect(computeUsagePercent(0.1, Number.NaN)).toEqual({ usagePercent: 0, remainingPercent: 100 });
	});

	it('未产生用量 = 0% / 100%', () => {
		expect(computeUsagePercent(0, 0.5)).toEqual({ usagePercent: 0, remainingPercent: 100 });
	});
});

// ===== 集成：GET /usage/v2 =====

describe('GET /usage/v2', () => {
	it('未带 Authorization 返回 401', async () => {
		const response = await SELF.fetch('https://example.com/usage/v2');
		expect(response.status).toBe(401);
	});

	it('AI Worker 异常（测试 mock 固定 599）时透传其状态码', async () => {
		mockAuth('user-1');
		const response = await SELF.fetch('https://example.com/usage/v2', {
			headers: { Authorization: 'Bearer test-jwt' },
		});
		expect(response.status).toBe(599);
		const body = (await response.text()) as string;
		expect(body).toBe('mock');
	});
});
