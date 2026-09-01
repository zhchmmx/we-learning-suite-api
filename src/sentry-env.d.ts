/**
 * Sentry 相关的环境变量类型增强。
 *
 * DSN 通过 `wrangler secret put SENTRY_DSN` 注入，属于 secret，
 * 不会出现在 `wrangler types` 自动生成的 worker-configuration.d.ts 里，
 * 因此这里做补充声明，供 Sentry.withSentry 的 options 回调读取。
 *
 * 注意：withSentry 回调里的 env 实际类型是 Cloudflare.Env（来自 `cloudflare:workers`），
 * 而非顶层全局 Env，所以两个都要增强；顶层 Env 作为兜底。
 *
 * 本地开发时在 .dev.vars 中提供 SENTRY_DSN（该文件已被 .gitignore 忽略）。
 */
declare global {
	namespace Cloudflare {
		interface Env {
			SENTRY_DSN?: string;
		}
	}
	interface Env {
		SENTRY_DSN?: string;
	}
}

export {};
