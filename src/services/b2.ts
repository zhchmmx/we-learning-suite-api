/**
 * Backblaze B2 存储服务
 *
 * 使用 S3 兼容 API，通过 AWS Signature V4 签名。
 * 参考 presign.ts 的签名逻辑，实现 Worker 中转上传和下载。
 */

interface B2UploadOptions {
	keyId: string;
	applicationKey: string;
	bucket: string;
	region: string; // 例如 "us-west-002"
	key: string;
	body: ReadableStream | ArrayBuffer;
	contentType: string;
}

interface B2GetOptions {
	keyId: string;
	applicationKey: string;
	bucket: string;
	region: string;
	key: string;
}

/**
 * 上传文件到 B2
 */
export async function uploadToB2(options: B2UploadOptions): Promise<{ size: number }> {
	const { keyId, applicationKey, bucket, region, key, body, contentType } = options;

	const host = `s3.${region}.backblazeb2.com`;
	const url = `https://${host}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

	const now = new Date();
	const amzDate = toAmzDate(now);
	const dateStamp = toDateStamp(now);

	// 构造请求头
	const headers: Record<string, string> = {
		'host': host,
		'x-amz-date': amzDate,
		'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
		'content-type': contentType,
	};

	// 构造 Canonical Request
	const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
	const canonicalQuerystring = '';
	const signedHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}`).join('\n') + '\n';
	const signedHeaderKeys = Object.keys(headers).sort().join(';');
	const payloadHash = 'UNSIGNED-PAYLOAD';

	const canonicalRequest = ['PUT', canonicalUri, canonicalQuerystring, signedHeaders, signedHeaderKeys, payloadHash].join('\n');

	// 构造 String to Sign
	const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

	// 计算签名
	const signingKey = await getSignatureKey(applicationKey, dateStamp, region, 's3');
	const signature = await hmacHex(signingKey, stringToSign);

	// 加上 Authorization 头
	headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

	// 发请求
	const response = await fetch(url, {
		method: 'PUT',
		headers,
		body: body as any,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`B2 upload failed: ${response.status} ${text}`);
	}

	return { size: Number(response.headers.get('content-length') || 0) };
}

/**
 * 从 B2 下载文件
 */
export async function getFromB2(options: B2GetOptions): Promise<Response> {
	const { keyId, applicationKey, bucket, region, key } = options;

	const host = `s3.${region}.backblazeb2.com`;
	const url = `https://${host}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

	const now = new Date();
	const amzDate = toAmzDate(now);
	const dateStamp = toDateStamp(now);

	// 构造请求头
	const headers: Record<string, string> = {
		'host': host,
		'x-amz-date': amzDate,
	};

	// 构造 Canonical Request
	const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
	const canonicalQuerystring = '';
	const signedHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}`).join('\n') + '\n';
	const signedHeaderKeys = Object.keys(headers).sort().join(';');
	const payloadHash = 'UNSIGNED-PAYLOAD';

	const canonicalRequest = ['GET', canonicalUri, canonicalQuerystring, signedHeaders, signedHeaderKeys, payloadHash].join('\n');

	// 构造 String to Sign
	const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

	// 计算签名
	const signingKey = await getSignatureKey(applicationKey, dateStamp, region, 's3');
	const signature = await hmacHex(signingKey, stringToSign);

	// 加上 Authorization 头
	headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

	// 发请求
	const response = await fetch(url, {
		method: 'GET',
		headers,
	});

	if (!response.ok) {
		throw new Error(`B2 download failed: ${response.status}`);
	}

	return response;
}

// ===== 工具函数（复用 presign.ts 的逻辑） =====

function toAmzDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function toDateStamp(date: Date): string {
	return toAmzDate(date).slice(0, 8);
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
	return hmac(kService, 'aws4_request');
}

function bufferToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
