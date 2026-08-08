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
		// Service Binding：内部直连出题 AI Worker（不走公网，无需 URL 和令牌）
		AI_WORKER: Fetcher;
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
	/**
	 * 展示用文件名，**不含扩展名**（"notes.txt" → "notes"）。
	 * D1 中仍存完整名，只在响应出口剥离。需要判断文件类型请用 mimeType；
	 * 需要完整名（下载落盘）请用 POST /presign/download/:id 返回的 fileName。
	 */
	name: string;
	path: string;
	size: number;
	mimeType: string;
	hasThumbnail: boolean;
	/** 文档的 quiz 生成状态：none=从未出题，generating=生成中，completed=已成功生成，failed=生成失败 */
	quizStatus: 'none' | 'generating' | 'completed' | 'failed';
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

/** Quiz 实体：一次出题的持久化结果 */
export interface QuizRecord {
	id: string;
	user_id: string;
	source_file_id: string;
	name: string;
	status: 'generating' | 'completed' | 'failed';
	created_at: string;
	updated_at: string;
}

/** Quiz 列表响应项（聚合了文件信息和题目统计） */
export interface QuizListItem {
	id: string;
	/** Quiz 标题。创建时默认取源文件名（已去扩展名），之后可通过 PATCH 改名 */
	name: string;
	sourceFileId: string;
	/** 源文件名，**不含扩展名**（"notes.txt" → "notes"） */
	sourceFileName: string;
	totalQuestions: number;
	graduatedQuestions: number;
	status: 'generating' | 'completed' | 'failed';
	createdAt: string;
	updatedAt: string;
}
