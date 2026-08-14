import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// wrangler.jsonc 声明了 Service Binding AI_WORKER → we-learning-suite-ai，
					// 但测试环境里没有另一个 Worker 在跑。这里注册一个同名 mock Worker，
					// 让 miniflare 能启动。测试用例可通过 SELF.fetch / 绑定覆盖走自己的断言逻辑。
					workers: [
						{
							name: "we-learning-suite-ai",
							modules: [
								{
									type: "ESModule",
									path: "mock-ai.mjs",
									contents: `export default { fetch: () => new Response("mock", { status: 599 }) };`,
								},
							],
							compatibilityDate: "2026-08-03",
						},
					],
				},
			},
		},
	},
});
