import { Hono } from 'hono';
import type { AppEnv, ImageRecord } from '../types';
import { uploadToB2, getFromB2 } from '../services/b2';

const images = new Hono<AppEnv>();

// ===== 工具函数 =====

/** 生成 B2 存储 key：userId/images/uuid */
function generateB2Key(userId: string, imageId: string): string {
	return `${userId}/images/${imageId}`;
}

// ===== 路由 =====

/**
 * POST /
 * 上传图片到 B2
 *
 * 请求头：
 *   X-Parent-File-Id: 所属文档 id（必填）
 *   X-Content-Hash: 图片内容哈希（可选）
 *   Content-Type: MIME 类型（可选，默认 image/png）
 *
 * 请求体：图片二进制流
 */
images.post('/', async (c) => {
	const userId = c.get('userId');
	const parentFileId = c.req.header('X-Parent-File-Id') || '';

	if (!parentFileId) {
		return c.json({ error: '"X-Parent-File-Id" header is required' }, 400);
	}

	// 验证所属文件存在且属于当前用户
	const parentFile = await c.env.DB.prepare(
		`SELECT id FROM files WHERE id = ? AND user_id = ? AND status = 'confirmed'`
	).bind(parentFileId, userId).first();

	if (!parentFile) {
		return c.json({ error: 'Parent file not found' }, 404);
	}

	const body = c.req.raw.body;
	if (!body) {
		return c.json({ error: 'Empty request body' }, 400);
	}

	const contentType = c.req.header('Content-Type') || 'image/png';
	if (!contentType.startsWith('image/')) {
		return c.json({ error: 'Content-Type must be an image type' }, 400);
	}

	const contentLength = parseInt(c.req.header('content-length') || '0', 10);
	const contentHash = c.req.header('X-Content-Hash') || null;

	// 生成图片 id 和 B2 key
	const imageId = crypto.randomUUID();
	const b2Key = generateB2Key(userId, imageId);

	// 上传到 B2
	try {
		await uploadToB2({
			keyId: c.env.B2_KEY_ID,
			applicationKey: c.env.B2_APPLICATION_KEY,
			bucket: c.env.B2_BUCKET_NAME,
			region: c.env.B2_REGION,
			key: b2Key,
			body: body,
			contentType: contentType,
		});
	} catch (e) {
		console.error('B2 upload failed:', e);
		return c.json({ error: 'Failed to upload image' }, 500);
	}

	// 写入 D1
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO images (id, user_id, parent_file_id, b2_key, content_hash, mime_type, size, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).bind(imageId, userId, parentFileId, b2Key, contentHash, contentType, contentLength, now).run();

	return c.json({
		data: {
			id: imageId,
			url: `/api/images/${imageId}`,
			contentType: contentType,
			size: contentLength,
		},
	}, 201);
});

/**
 * GET /:id
 * 获取图片（从 B2 拉取并返回）
 */
images.get('/:id', async (c) => {
	const userId = c.get('userId');
	const imageId = c.req.param('id');

	// 查元数据确认权限
	const record = await c.env.DB.prepare(
		`SELECT * FROM images WHERE id = ? AND user_id = ?`
	).bind(imageId, userId).first<ImageRecord>();

	if (!record) {
		return c.json({ error: 'Image not found' }, 404);
	}

	// 从 B2 拉取
	try {
		const response = await getFromB2({
			keyId: c.env.B2_KEY_ID,
			applicationKey: c.env.B2_APPLICATION_KEY,
			bucket: c.env.B2_BUCKET_NAME,
			region: c.env.B2_REGION,
			key: record.b2_key,
		});

		const headers = new Headers();
		headers.set('Content-Type', record.mime_type);
		headers.set('Content-Length', String(record.size));
		headers.set('Cache-Control', 'public, max-age=86400');

		return new Response(response.body, { headers });
	} catch (e) {
		console.error('B2 download failed:', e);
		return c.json({ error: 'Image not found in storage' }, 404);
	}
});

export { images };
