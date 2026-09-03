import { env, SELF, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// 0009 是被测对象本身，必须读真实迁移文件，不能在测试里重抄一遍。
// 建表 DDL 反而手工内联：D1 的 exec() 按换行而非分号切语句，喂不了原始迁移文件，
// 而官方 applyD1Migrations() 要求 Node 侧 readD1Migrations() 再经 miniflare binding
// 注入，得改动共享的 vitest.config.mts。沿用 storage-quota.spec.ts 的内联建表约定。
import sql0009 from "../migrations/0009_fix_quiz_status.sql?raw";

const USER = "user-1";
const ISO = "2026-09-01T00:00:00.000Z";

/** 与 migrations 最终结构一致（quizzes: 0005 + 0007 / quiz_sessions: 0005 + 0007 + 0008） */
const QUIZZES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS quizzes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_file_id TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'generating',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	fail_reason TEXT
)`;

const SESSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS quiz_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	quiz_id TEXT NOT NULL,
	source_file_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	completed_at TEXT,
	fail_reason TEXT,
	progress TEXT
)`;

/** 未来时间：ticketAuthMiddleware 会拒绝已过期的票 */
function aliveTicketExpiresAt(): string {
	return new Date(Date.now() + 30 * 60_000).toISOString();
}

function pastExpiresAt(): string {
	return new Date(Date.now() - 60 * 60_000).toISOString();
}

interface SeedOptions {
	/** 同时作为 quiz.id 与 session.id —— 保持 ticket == quiz.id == session.id 不变量 */
	id: string;
	quizStatus: string;
	sessionStatus?: string;
	expiresAt?: string;
	/** false = 只建 quiz，不建 session（模拟票已被清理） */
	withSession?: boolean;
	/** 挂到哪个文档下；省略时用 file-<id> */
	sourceFileId?: string;
}

async function seed(options: SeedOptions): Promise<void> {
	const sourceFileId = options.sourceFileId ?? `file-${options.id}`;

	await env.DB.prepare(
		`INSERT INTO quizzes (id, user_id, source_file_id, name, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(options.id, USER, sourceFileId, "第三章讲义", options.quizStatus, ISO, ISO)
		.run();

	if (options.withSession === false) return;

	await env.DB.prepare(
		`INSERT INTO quiz_sessions (id, user_id, quiz_id, source_file_id, status, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			options.id,
			USER,
			options.id,
			sourceFileId,
			options.sessionStatus ?? "pending",
			options.expiresAt ?? aliveTicketExpiresAt(),
			ISO,
		)
		.run();
}

async function readQuizStatus(id: string): Promise<string> {
	const row = await env.DB.prepare(`SELECT status FROM quizzes WHERE id = ?`).bind(id).first<{ status: string }>();
	return row!.status;
}

async function readSession(id: string): Promise<{ status: string; completed_at: string | null; fail_reason: string | null }> {
	const row = await env.DB
		.prepare(`SELECT status, completed_at, fail_reason FROM quiz_sessions WHERE id = ?`)
		.bind(id)
		.first<{ status: string; completed_at: string | null; fail_reason: string | null }>();
	return row!;
}

/** AI Worker 回调：凭证只有 X-Quiz-Ticket 头，无需用户 JWT */
function patchStatus(ticket: string, body: Record<string, unknown>): Promise<Response> {
	return SELF.fetch(`https://example.com/api/quiz/sessions/${ticket}/status`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", "X-Quiz-Ticket": ticket },
		body: JSON.stringify(body),
	});
}

/**
 * 把迁移文件切成逐条语句。
 * ⚠️ 前提：迁移 SQL 里分号只作语句结束符（注释与字符串字面量内不得出现分号）。
 * 下面的数量断言就是把这个隐含前提变成显式失败，而不是静默少跑一条。
 */
function splitMigration(sql: string): string[] {
	return sql
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

const FILES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS files (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	path TEXT NOT NULL DEFAULT '/',
	r2_key TEXT NOT NULL,
	size INTEGER NOT NULL DEFAULT 0,
	mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	thumbnail_key TEXT,
	status TEXT NOT NULL DEFAULT 'confirmed',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

// ===== Appwrite 外呼 mock（authMiddleware 验 JWT + quotaCheckMiddleware 查订阅）=====

const APPWRITE_ORIGIN = new URL(env.APPWRITE_ENDPOINT).origin;
const APPWRITE_PATH = (suffix: string) => new URL(`${env.APPWRITE_ENDPOINT}${suffix}`).pathname;
const AUTH_PATH = APPWRITE_PATH('/account');
const EXECUTIONS_PATH = APPWRITE_PATH(`/functions/${env.APPWRITE_FUNCTION_ID}/executions`);

/** 放行 authMiddleware：/account 返回用户 */
function mockAuthOk(userId = USER) {
	fetchMock
		.get(APPWRITE_ORIGIN)
		.intercept({ method: 'GET', path: AUTH_PATH })
		.reply(200, JSON.stringify({ $id: userId, email: 'test@example.com', name: 'Test' }));
}

/**
 * 订阅查询失败 → fetchSubscription 返回 null → quotaLimit 回退 0.5。
 * 配额本身不是本文件的被测对象，这里只要保证它放行。
 * AI Worker /api/usage 由 vitest.config.mts 里的 mock worker 返回 599，
 * quotaCheckMiddleware 见到 !ok 会直接 next()。
 */
function mockSubscriptionUnavailable() {
	fetchMock
		.get(APPWRITE_ORIGIN)
		.intercept({ method: 'POST', path: EXECUTIONS_PATH })
		.reply(500, 'internal error');
}

async function seedFile(id: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO files (id, user_id, name, r2_key, size, mime_type, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1024, 'text/plain', 'confirmed', ?, ?)`
	)
		.bind(id, USER, `${id}.txt`, `${USER}/${id}`, ISO, ISO)
		.run();
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(async () => {
	await env.DB.prepare(QUIZZES_TABLE_SQL).run();
	await env.DB.prepare(SESSIONS_TABLE_SQL).run();
	await env.DB.prepare(FILES_TABLE_SQL).run();
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM quizzes`).bind(),
		env.DB.prepare(`DELETE FROM quiz_sessions`).bind(),
		env.DB.prepare(`DELETE FROM files`).bind(),
	]);
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe("PATCH /sessions/:id/status 的两表状态词表翻译", () => {
	it("session 写 processing，quiz 必须翻译为 generating", async () => {
		const id = crypto.randomUUID();
		await seed({ id, quizStatus: "generating", sessionStatus: "pending" });

		const res = await patchStatus(id, { status: "processing" });
		expect(res.status).toBe(200);

		// 响应体回显 AI Worker 传来的原值（它面对的是 session 语义），不受翻译影响
		const body = (await res.json()) as { data: { status: string } };
		expect(body.data.status).toBe("processing");

		expect((await readSession(id)).status).toBe("processing");
		// 核心断言：修复前这里也是 processing，导致 quiz.ts:326 复用分支永久不可达
		expect(await readQuizStatus(id)).toBe("generating");
	});

	it("failed + 白名单 reason 同步写进两张表", async () => {
		const id = crypto.randomUUID();
		await seed({ id, quizStatus: "generating", sessionStatus: "processing" });

		const res = await patchStatus(id, { status: "failed", reason: "CONTENT_BLOCKED" });
		expect(res.status).toBe(200);

		const session = await readSession(id);
		expect(session.status).toBe("failed");
		expect(session.fail_reason).toBe("CONTENT_BLOCKED");
		expect(session.completed_at).not.toBeNull();

		const quiz = await env.DB
			.prepare(`SELECT status, fail_reason FROM quizzes WHERE id = ?`)
			.bind(id)
			.first<{ status: string; fail_reason: string | null }>();
		expect(quiz!.status).toBe("failed");
		expect(quiz!.fail_reason).toBe("CONTENT_BLOCKED");
	});

	it("completed 两端取值一致，原样写入", async () => {
		const id = crypto.randomUUID();
		await seed({ id, quizStatus: "generating", sessionStatus: "processing" });

		const res = await patchStatus(id, { status: "completed" });
		expect(res.status).toBe(200);
		expect((await readSession(id)).status).toBe("completed");
		expect(await readQuizStatus(id)).toBe("completed");
	});

	it("清单外的状态值返回 400 且不改动任何一行", async () => {
		const id = crypto.randomUUID();
		await seed({ id, quizStatus: "generating", sessionStatus: "pending" });

		const res = await patchStatus(id, { status: "bogus" });
		expect(res.status).toBe(400);

		expect((await readSession(id)).status).toBe("pending");
		expect(await readQuizStatus(id)).toBe("generating");
	});

	it("过期票被 ticketAuthMiddleware 拒绝", async () => {
		const id = crypto.randomUUID();
		await seed({ id, quizStatus: "generating", sessionStatus: "pending", expiresAt: pastExpiresAt() });

		const res = await patchStatus(id, { status: "processing" });
		expect(res.status).toBe(401);
		expect(await readQuizStatus(id)).toBe("generating");
	});
});

describe("POST /sessions 生成中重复触发的后果", () => {
	/** 走完整中间件链（authMiddleware + quotaCheckMiddleware） */
	function createSession(sourceFileId: string): Promise<Response> {
		return SELF.fetch("https://example.com/api/quiz/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-jwt" },
			body: JSON.stringify({ sourceFileId }),
		});
	}

	it("quiz 处于 generating 时重复点击返回 200 复用，不再新建", async () => {
		// 这正是修复后 quiz.ts:592 会留在库里的值：AI 已受理、任务仍在跑
		const fileId = `file-${crypto.randomUUID()}`;
		const quizId = crypto.randomUUID();
		await seedFile(fileId);
		await seed({ id: quizId, quizStatus: "generating", sessionStatus: "processing", sourceFileId: fileId });
		mockAuthOk();
		mockSubscriptionUnavailable();

		const res = await createSession(fileId);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { data: { quizId: string; status: string } };
		expect(body.data.status).toBe("generating");
		// 复用同一 quizId，没有另起任务
		expect(body.data.quizId).toBe(quizId);

		const rows = await env.DB
			.prepare(`SELECT COUNT(*) AS n FROM quizzes WHERE source_file_id = ?`)
			.bind(fileId)
			.first<{ n: number }>();
		expect(rows!.n).toBe(1);
	});

	it("对照：quiz 残留 legacy 'processing' 时同一次点击会 500（故必须跑 0009）", async () => {
		const fileId = `file-${crypto.randomUUID()}`;
		await seedFile(fileId);
		await seed({ id: crypto.randomUUID(), quizStatus: "processing", sessionStatus: "processing", sourceFileId: fileId });
		mockAuthOk();
		mockSubscriptionUnavailable();

		const res = await createSession(fileId);
		// generating / completed / failed 三条分支全部落空 → 掉进新建分支 → 撞 source_file_id UNIQUE
		expect(res.status).toBe(500);

		// 且不留半成品：失败的 INSERT 不该新增任何 quiz 行
		const rows = await env.DB
			.prepare(`SELECT COUNT(*) AS n FROM quizzes WHERE source_file_id = ?`)
			.bind(fileId)
			.first<{ n: number }>();
		expect(rows!.n).toBe(1);
	});
});

describe("0009 存量脏数据迁移", () => {
	it("无有效票的 processing 判 failed，仍有有效票的恢复 generating", async () => {
		// A：票已过期 ⇒ AI Worker 早已停止续期，判 failed 让用户能走 quiz.ts:354 复活重试
		const expired = crypto.randomUUID();
		await seed({ id: expired, quizStatus: "processing", sessionStatus: "processing", expiresAt: pastExpiresAt() });

		// B：票仍在有效期 ⇒ 任务确实在跑，恢复成语义正确的 generating
		const alive = crypto.randomUUID();
		await seed({ id: alive, quizStatus: "processing", sessionStatus: "processing", expiresAt: aliveTicketExpiresAt() });

		// C：session 行已被清理，只剩 quiz ⇒ 同样判 failed
		const orphan = crypto.randomUUID();
		await seed({ id: orphan, quizStatus: "processing", withSession: false });

		// D：本来就是 completed 的行必须完全不受影响
		const done = crypto.randomUUID();
		await seed({ id: done, quizStatus: "completed", sessionStatus: "completed", expiresAt: pastExpiresAt() });

		const statements = splitMigration(sql0009);
		expect(statements).toHaveLength(3);
		for (const statement of statements) {
			await env.DB.prepare(statement).run();
		}

		expect(await readQuizStatus(expired)).toBe("failed");
		expect((await readSession(expired)).status).toBe("failed");

		expect(await readQuizStatus(alive)).toBe("generating");
		expect((await readSession(alive)).status).toBe("processing");

		expect(await readQuizStatus(orphan)).toBe("failed");

		expect(await readQuizStatus(done)).toBe("completed");
		expect((await readSession(done)).status).toBe("completed");

		// 兜底：迁移后库里不该再有任何清单外的状态值
		const leaked = await env.DB
			.prepare(`SELECT COUNT(*) AS n FROM quizzes WHERE status NOT IN ('generating','completed','failed')`)
			.first<{ n: number }>();
		expect(leaked!.n).toBe(0);
	});
});
