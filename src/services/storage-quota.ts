import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { fetchSubscription } from './appwrite';

/** 免费档默认存储配额：500 MB（订阅记录缺失 storageLimit 或 Appwrite 调用失败时回退） */
export const DEFAULT_FREE_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;

export interface StorageQuotaCheck {
	allowed: boolean;
	quotaLimitBytes: number;
	currentUsageBytes: number;
	requestedBytes: number;
}

/**
 * 获取用户存储配额上限（字节）。
 * 订阅记录带 storageLimit 时用它；字段缺失或 Appwrite 调用失败时回退免费默认值，
 * 与 AI 配额的 quotaLimit 回退策略一致。
 */
export async function getStorageQuotaLimit(c: Context<AppEnv>): Promise<number> {
	const subscription = await fetchSubscription(c);
	return subscription?.storageLimit ?? DEFAULT_FREE_STORAGE_LIMIT_BYTES;
}

/**
 * 获取用户当前存储用量（字节）。
 * 口径：SUM(files.size) —— confirmed 与 pending 全部计入
 * （pending 记录真实占用 R2 空间，且 confirm 时强制校验大小一致，无绕过空间）；
 * 缩略图不计入（D1 无大小记录，量级可忽略）。
 */
export async function getStorageUsageBytes(db: D1Database, userId: string): Promise<number> {
	const result = await db
		.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = ?')
		.bind(userId)
		.first<{ used: number }>();
	return result?.used ?? 0;
}

/**
 * 纯函数判定：已用 + 请求 ≤ 上限 即放行（恰好用满上限允许，放得下就放行）。
 */
export function evaluateStorageQuota(limitBytes: number, usedBytes: number, requestedBytes: number): boolean {
	return usedBytes + requestedBytes <= limitBytes;
}

/**
 * 组合检查（上传前调用）。
 *
 * 返回 null 表示跳过检查（D1 用量查询异常，fail-open 放行），
 * 与 AI 配额对用量服务故障的处理一致。
 * 注意：配额上限获取失败不会导致跳过 —— 上限回退默认值，检查仍然生效。
 */
export async function checkStorageQuota(
	c: Context<AppEnv>,
	requestedBytes: number
): Promise<StorageQuotaCheck | null> {
	let currentUsageBytes: number;
	try {
		currentUsageBytes = await getStorageUsageBytes(c.env.DB, c.get('userId'));
	} catch (err) {
		console.error('Storage quota check: usage query error:', err);
		return null;
	}

	const quotaLimitBytes = await getStorageQuotaLimit(c);

	return {
		allowed: evaluateStorageQuota(quotaLimitBytes, currentUsageBytes, requestedBytes),
		quotaLimitBytes,
		currentUsageBytes,
		requestedBytes,
	};
}
