/**
 * 环境变量类型定义
 * 运行 `npx wrangler types` 后会自动更新 worker-configuration.d.ts
 * 这里定义的是代码中使用的类型辅助
 */

export interface AppEnv {
	Bindings: {
		R2_BUCKET: R2Bucket;
		DB: D1Database;
		APPWRITE_ENDPOINT: string;
		APPWRITE_PROJECT_ID: string;
		AI_WORKER_URL: string;
		// 以下通过 wrangler secret put 设置
		R2_ACCESS_KEY_ID: string;
		R2_SECRET_ACCESS_KEY: string;
		CLOUDFLARE_ACCOUNT_ID: string;
	};
	Variables: {
		userId: string;
		sessionId: string;
	};
}

export interface FileRecord {
	id: string;
	user_id: string;
	name: string;
	path: string;
	r2_key: string;
	size: number;
	mime_type: string;
	status: 'confirmed' | 'pending';
	thumbnail_key: string | null;
	created_at: string;
	updated_at: string;
}

export interface FileMetadataResponse {
	id: string;
	name: string;
	path: string;
	size: number;
	mimeType: string;
	hasThumbnail: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ListFilesResponse {
	files: FileMetadataResponse[];
	total: number;
	page: number;
	limit: number;
}

export interface PresignUploadResponse {
	uploadUrl: string;
	fileId: string;
	r2Key: string;
	expiresIn: number;
}

export interface PresignDownloadResponse {
	downloadUrl: string;
	expiresIn: number;
}
