import { Hono } from 'hono';
import type { AppEnv, FileRecord, FileMetadataResponse, ListFilesResponse } from '../types';
import { generatePresignedUrl } from '../services/presign';

const files = new Hono<AppEnv>();

const BUCKET_NAME = 'we-learning-suite';

// ===== 工具函数 =====

function toResponse(record: FileRecord): FileMetadataResponse {
	return {
		id: record.id,
		name: record.name,
		path: record.path,
		size: record.size,
		mimeType: record.mime_type,
		hasThumbnail: !!record.thumbnail_key,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	};
}

/** 规范化路径：确保以 / 开头和结尾，去除多余斜杠 */
function normalizePath(p: string): string {
	if (!p || p === '/') return '/';
	let normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/');
	if (!normalized.startsWith('/')) normalized = '/' + normalized;
	if (!normalized.endsWith('/')) normalized = normalized + '/';
	return normalized;
}

/** 生成 R2 存储 key：userId/path/uuid */
function generateR2Key(userId: string, path: string, fileId: string): string {
	const cleanPath = path === '/' ? '' : path.replace(/^\//, '').replace(/\/$/, '');
	return cleanPath ? `${userId}/${cleanPath}/${fileId}` : `${userId}/${fileId}`;
}

/** 验证文件名合法性 */
function isValidFileName(name: string): boolean {
	if (!name || name.length > 255) return false;
	// 禁止路径分隔符和特殊字符
	if (/[/\\:*?"<>|]/.test(name)) return false;
	if (name === '.' || name === '..') return false;
	return true;
}

// ===== 路由 =====

/**
 * POST /upload
 * 上传文件（小文件，≤100MB，通过 Worker 流式中转）
 *
 * 请求：multipart/form-data
 *   - file: 文件内容（必填）
 *   - path: 目标目录路径（可选，默认 "/"）
 *   - name: 自定义文件名（可选，默认使用上传文件的原始名）
 */
files.post('/upload', async (c) => {
	const userId = c.get('userId');
	const contentType = c.req.header('content-type') || '';

	let fileBody: ReadableStream;
	let fileName: string;
	let mimeType: string;
	let targetPath: string;

	if (contentType.includes('multipart/form-data')) {
		// multipart 表单上传
		const formData = await c.req.formData();
		const file = formData.get('file');

		if (!file || !(file instanceof File)) {
			return c.json({ error: 'Missing "file" field in form data' }, 400);
		}

		fileBody = file.stream();
		fileName = (formData.get('name') as string) || file.name;
		mimeType = file.type || 'application/octet-stream';
		targetPath = normalizePath((formData.get('path') as string) || '/');
	} else {
		// 原始二进制流上传（客户端直接 PUT/POST body）
		fileBody = c.req.raw.body as ReadableStream;
		fileName = decodeURIComponent(c.req.header('X-File-Name') || 'unnamed');
		mimeType = c.req.header('Content-Type') || 'application/octet-stream';
		targetPath = normalizePath(decodeURIComponent(c.req.header('X-File-Path') || '/'));

		if (!fileBody) {
			return c.json({ error: 'Empty request body' }, 400);
		}
	}

	// 验证文件名
	if (!isValidFileName(fileName)) {
		return c.json({ error: 'Invalid file name. Cannot contain /\\:*?"<>| and must be 1-255 characters.' }, 400);
	}

	// 生成文件 ID 和 R2 key
	const fileId = crypto.randomUUID();
	const r2Key = generateR2Key(userId, targetPath, fileId);

	// 流式上传到 R2
	const putResult = await c.env.R2_BUCKET.put(r2Key, fileBody, {
		httpMetadata: { contentType: mimeType },
		customMetadata: { fileName, userId, path: targetPath },
	});

	if (!putResult) {
		return c.json({ error: 'Failed to upload file to storage' }, 500);
	}

	// 写入 D1 元数据
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO files (id, user_id, name, path, r2_key, size, mime_type, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(fileId, userId, fileName, targetPath, r2Key, putResult.size, mimeType, now, now)
		.run();

	return c.json({ data: toResponse({
		id: fileId,
		user_id: userId,
		name: fileName,
		path: targetPath,
		r2_key: r2Key,
		size: putResult.size,
		mime_type: mimeType,
		thumbnail_key: null,
		created_at: now,
		updated_at: now,
	}) }, 201);
});

/**
 * GET /
 * 列出文件（支持路径过滤和分页）
 *
 * 查询参数：
 *   - path: 目录路径（默认 "/"，列出该目录下的文件）
 *   - recursive: 是否递归列出子目录（默认 false）
 *   - page: 页码（默认 1）
 *   - limit: 每页数量（默认 50，最大 200）
 */
files.get('/', async (c) => {
	const userId = c.get('userId');
	const path = normalizePath(c.req.query('path') || '/');
	const recursive = c.req.query('recursive') === 'true';
	const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
	const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
	const offset = (page - 1) * limit;

	let query: string;
	let countQuery: string;
	const params: (string | number)[] = [userId];

	if (recursive) {
		// 递归：列出该路径及所有子路径下的文件
		const pathPrefix = path === '/' ? '/' : path;
		query = `SELECT * FROM files WHERE user_id = ? AND (path = ? OR path LIKE ?) ORDER BY created_at DESC LIMIT ? OFFSET ?`;
		countQuery = `SELECT COUNT(*) as total FROM files WHERE user_id = ? AND (path = ? OR path LIKE ?)`;
		params.push(pathPrefix, `${pathPrefix}%`);
	} else {
		// 仅当前目录
		query = `SELECT * FROM files WHERE user_id = ? AND path = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`;
		countQuery = `SELECT COUNT(*) as total FROM files WHERE user_id = ? AND path = ?`;
		params.push(path);
	}

	const [filesResult, countResult] = await Promise.all([
		c.env.DB.prepare(query).bind(...params, limit, offset).all<FileRecord>(),
		c.env.DB.prepare(countQuery).bind(...params).first<{ total: number }>(),
	]);

	const response: ListFilesResponse = {
		files: (filesResult.results || []).map(toResponse),
		total: countResult?.total || 0,
		page,
		limit,
	};

	return c.json({ data: response });
});

/**
 * GET /:id
 * 获取单个文件的元信息
 */
files.get('/:id', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	return c.json({ data: toResponse(record) });
});

/**
 * GET /:id/download
 * 下载文件内容（从 R2 流式返回）
 */
files.get('/:id/download', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	// 先查元数据确认权限
	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	// 从 R2 获取文件
	const object = await c.env.R2_BUCKET.get(record.r2_key);

	if (!object) {
		return c.json({ error: 'File content not found in storage' }, 404);
	}

	// 流式返回，附带正确的 Content-Type 和下载文件名
	const headers = new Headers();
	headers.set('Content-Type', record.mime_type);
	headers.set('Content-Length', String(record.size));
	headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(record.name)}"`);
	headers.set('ETag', object.etag);

	return new Response(object.body, { headers });
});

/**
 * DELETE /:id
 * 删除文件（同时删除 R2 对象和 D1 记录）
 */
files.delete('/:id', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	// 并行删除 R2 对象（含缩略图）和 D1 记录
	const deleteOps: Promise<unknown>[] = [
		c.env.R2_BUCKET.delete(record.r2_key),
		c.env.DB.prepare(`DELETE FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).run(),
	];
	if (record.thumbnail_key) {
		deleteOps.push(c.env.R2_BUCKET.delete(record.thumbnail_key));
	}
	await Promise.all(deleteOps);

	return c.json({ data: { deleted: true, id: fileId } });
});

/**
 * PATCH /:id
 * 重命名或移动文件
 *
 * 请求体 JSON：
 *   - name: 新文件名（可选）
 *   - path: 新目录路径（可选）
 *   至少提供一个。
 */
files.patch('/:id', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	let body: { name?: string; path?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.name && !body.path) {
		return c.json({ error: 'Provide at least "name" or "path" to update' }, 400);
	}

	if (body.name && !isValidFileName(body.name)) {
		return c.json({ error: 'Invalid file name' }, 400);
	}

	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	const newName = body.name || record.name;
	const newPath = body.path ? normalizePath(body.path) : record.path;

	// 如果路径变了，需要移动 R2 对象
	let r2Key = record.r2_key;
	if (newPath !== record.path) {
		const newR2Key = generateR2Key(userId, newPath, fileId);

		// R2 没有原生 move，需要 copy + delete
		const sourceObject = await c.env.R2_BUCKET.get(record.r2_key);
		if (sourceObject) {
			await c.env.R2_BUCKET.put(newR2Key, sourceObject.body, {
				httpMetadata: sourceObject.httpMetadata,
				customMetadata: { ...sourceObject.customMetadata, fileName: newName, path: newPath },
			});
			await c.env.R2_BUCKET.delete(record.r2_key);
			r2Key = newR2Key;
		}
	}

	const now = new Date().toISOString();
	await c.env.DB.prepare(`UPDATE files SET name = ?, path = ?, r2_key = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
		.bind(newName, newPath, r2Key, now, fileId, userId)
		.run();

	// 返回更新后的记录
	const updated = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	return c.json({ data: toResponse(updated!) });
});

// ===== 缩略图端点 =====

/**
 * POST /:id/thumbnail
 * 上传/更新文件缩略图
 *
 * 请求体：图片二进制流（image/webp 或 image/jpeg）
 * 客户端负责生成缩略图，服务端只负责存储。
 */
files.post('/:id/thumbnail', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	const body = c.req.raw.body;
	if (!body) {
		return c.json({ error: 'Empty request body' }, 400);
	}

	const contentType = c.req.header('Content-Type') || 'image/webp';
	if (!contentType.startsWith('image/')) {
		return c.json({ error: 'Content-Type must be an image type' }, 400);
	}

	// 缩略图 R2 key：userId/thumbnails/fileId.webp
	const ext = contentType.includes('png') ? 'png' : contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'webp';
	const thumbnailKey = `${userId}/thumbnails/${fileId}.${ext}`;

	// 如果之前有缩略图且 key 不同，删除旧的
	if (record.thumbnail_key && record.thumbnail_key !== thumbnailKey) {
		await c.env.R2_BUCKET.delete(record.thumbnail_key);
	}

	// 存储缩略图
	await c.env.R2_BUCKET.put(thumbnailKey, body, {
		httpMetadata: { contentType },
	});

	// 更新 D1
	const now = new Date().toISOString();
	await c.env.DB.prepare(`UPDATE files SET thumbnail_key = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
		.bind(thumbnailKey, now, fileId, userId)
		.run();

	return c.json({ data: { fileId, thumbnailKey, contentType } }, 201);
});

/**
 * GET /:id/thumbnail
 * 获取文件缩略图（流式返回图片）
 */
files.get('/:id/thumbnail', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	if (!record.thumbnail_key) {
		return c.json({ error: 'No thumbnail for this file' }, 404);
	}

	const object = await c.env.R2_BUCKET.get(record.thumbnail_key);

	if (!object) {
		return c.json({ error: 'Thumbnail not found in storage' }, 404);
	}

	const headers = new Headers();
	headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp');
	headers.set('Cache-Control', 'public, max-age=86400');
	headers.set('ETag', object.etag);

	return new Response(object.body, { headers });
});

// ===== 预签名 URL 端点（大文件） =====

/**
 * POST /presign/upload
 * 获取大文件上传的预签名 URL（>100MB 文件使用）
 *
 * 请求体 JSON：
 *   - name: 文件名（必填）
 *   - path: 目标目录（可选，默认 "/"）
 *   - size: 文件大小（字节，必填）
 *   - mimeType: MIME 类型（可选）
 *
 * 返回预签名 URL，客户端直接 PUT 文件到该 URL。
 * 上传完成后需调用 POST /presign/confirm 确认。
 */
files.post('/presign/upload', async (c) => {
	const userId = c.get('userId');

	let body: { name: string; path?: string; size: number; mimeType?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.name || !isValidFileName(body.name)) {
		return c.json({ error: 'Valid "name" is required' }, 400);
	}
	if (!body.size || body.size <= 0) {
		return c.json({ error: 'Valid "size" is required' }, 400);
	}

	const targetPath = normalizePath(body.path || '/');
	const mimeType = body.mimeType || 'application/octet-stream';
	const fileId = crypto.randomUUID();
	const r2Key = generateR2Key(userId, targetPath, fileId);

	// 先在 D1 中创建记录（size 先写入，后续 confirm 时验证）
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO files (id, user_id, name, path, r2_key, size, mime_type, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(fileId, userId, body.name, targetPath, r2Key, body.size, mimeType, now, now)
		.run();

	// 生成预签名上传 URL
	const uploadUrl = await generatePresignedUrl({
		accountId: c.env.CLOUDFLARE_ACCOUNT_ID,
		accessKeyId: c.env.R2_ACCESS_KEY_ID,
		secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
		bucket: BUCKET_NAME,
		key: r2Key,
		method: 'PUT',
		expiresIn: 900,
		contentType: mimeType,
	});

	return c.json({
		data: {
			uploadUrl,
			fileId,
			r2Key,
			expiresIn: 900,
			headers: { 'Content-Type': mimeType },
		},
	});
});

/**
 * POST /presign/download/:id
 * 获取大文件下载的预签名 URL
 */
files.post('/presign/download/:id', async (c) => {
	const userId = c.get('userId');
	const fileId = c.req.param('id');

	const record = await c.env.DB.prepare(`SELECT * FROM files WHERE id = ? AND user_id = ?`).bind(fileId, userId).first<FileRecord>();

	if (!record) {
		return c.json({ error: 'File not found' }, 404);
	}

	const downloadUrl = await generatePresignedUrl({
		accountId: c.env.CLOUDFLARE_ACCOUNT_ID,
		accessKeyId: c.env.R2_ACCESS_KEY_ID,
		secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
		bucket: BUCKET_NAME,
		key: record.r2_key,
		method: 'GET',
		expiresIn: 900,
	});

	return c.json({
		data: {
			downloadUrl,
			expiresIn: 900,
			fileName: record.name,
			mimeType: record.mime_type,
		},
	});
});

export { files };
