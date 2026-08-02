/**
 * R2 预签名 URL 生成服务
 *
 * 使用 AWS Signature V4 查询字符串签名方式，
 * 为 R2 的 S3 兼容 API 生成临时上传/下载链接。
 * 客户端拿到链接后可直接对 R2 发起请求，无需经过 Worker 中转。
 */

interface PresignOptions {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
	key: string;
	method: 'GET' | 'PUT';
	expiresIn?: number; // 秒，默认 900（15分钟）
	contentType?: string; // 仅上传时需要
}

const REGION = 'auto';
const SERVICE = 's3';

/**
 * 生成预签名 URL
 */
export async function generatePresignedUrl(options: PresignOptions): Promise<string> {
	const { accountId, accessKeyId, secretAccessKey, bucket, key, method, expiresIn = 900, contentType } = options;

	const host = `${accountId}.r2.cloudflarestorage.com`;
	const endpoint = `https://${host}/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
	const url = new URL(endpoint);

	const now = new Date();
	const amzDate = toAmzDate(now);
	const dateStamp = toDateStamp(now);

	// 构造查询参数
	url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
	url.searchParams.set('X-Amz-Credential', `${accessKeyId}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`);
	url.searchParams.set('X-Amz-Date', amzDate);
	url.searchParams.set('X-Amz-Expires', String(expiresIn));
	url.searchParams.set('X-Amz-SignedHeaders', 'host');

	// 构造 Canonical Request
	const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
	const canonicalQuerystring = sortQueryParams(url.searchParams);
	const canonicalHeaders = `host:${host}\n`;
	const signedHeaders = 'host';
	const payloadHash = 'UNSIGNED-PAYLOAD';

	const canonicalRequest = [method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash].join('\n');

	// 构造 String to Sign
	const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

	// 计算签名
	const signingKey = await getSignatureKey(secretAccessKey, dateStamp, REGION, SERVICE);
	const signature = await hmacHex(signingKey, stringToSign);

	// 最终 URL
	url.searchParams.set('X-Amz-Signature', signature);

	// 如果是上传且指定了 Content-Type，加入响应头提示
	if (method === 'PUT' && contentType) {
		// Content-Type 需要客户端在 PUT 时自行设置，预签名 URL 不强制
	}

	return url.toString();
}

// ===== 工具函数 =====

function toAmzDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function toDateStamp(date: Date): string {
	return toAmzDate(date).slice(0, 8);
}

function sortQueryParams(params: URLSearchParams): string {
	const entries = Array.from(params.entries());
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
	return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function sha256Hex(data: string): Promise<string> {
	const encoder = new TextEncoder();
	const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
	return bufferToHex(hash);
}

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const encoder = new TextEncoder();
	return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
	const result = await hmac(key, data);
	return bufferToHex(result);
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
	const encoder = new TextEncoder();
	const kDate = await hmac(encoder.encode(`AWS4${secretKey}`).buffer as ArrayBuffer, dateStamp);
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	const kSigning = await hmac(kService, 'aws4_request');
	return kSigning;
}

function bufferToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
