# we-learning-suite-api

基于 Cloudflare Workers 的学习套件后端 API，使用 Appwrite JWT 鉴权，R2 存储文件本体，D1 存储元数据。包含文件管理、We Quiz（AI 出题 + 作答记录 + 服务端毕业判定）和用量查询三大模块。

## 技术栈

- **运行时**: Cloudflare Workers
- **路由**: Hono
- **存储**: R2（文件本体）+ D1（元数据）
- **鉴权**: Appwrite JWT（通过 Appwrite REST API 验证）
- **监控**: Sentry（`@sentry/cloudflare`）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

编辑 `wrangler.jsonc`，填入：

- `APPWRITE_ENDPOINT`: 你的 Appwrite endpoint（如 `https://cloud.appwrite.io/v1`）
- `APPWRITE_PROJECT_ID`: 你的 Appwrite 项目 ID
- `APPWRITE_FUNCTION_ID`: 订阅服务 Function ID（用于查询 AI / 存储配额）
- Service Binding `AI_WORKER`: 指向出题 AI Worker（we-learning-suite-ai），内部直连，不走公网、无需配置地址
- D1 的 `database_id`: 在 Cloudflare 控制台 → D1 → 你的数据库 → Settings 中获取

### 3. 设置 Secrets

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put SENTRY_DSN
```

R2 API Token 在 Cloudflare 控制台 → R2 → Manage R2 API Tokens 中创建（需要 Object Read & Write 权限）。

### 4. 初始化数据库

```bash
npx wrangler d1 migrations apply we-learning-suite-db
```

### 5. 本地开发

```bash
npx wrangler dev
```

联调出题链路时，AI Worker 项目也要同时 `npx wrangler dev --port 8788`——Service Binding 会自动指向本地实例。

### 6. 部署

```bash
npx wrangler deploy
```

---

## API 文档

所有 `/api/files` 与 `/api/quiz` 的用户接口都需要在请求头中携带 Appwrite JWT：

```
Authorization: Bearer <your-jwt-token>
```

JWT 通过桌面客户端调用 Appwrite 的 `CreateJWT()` 获取。

---

### 健康检查

```
GET /health
```

无需鉴权。返回服务状态。

**响应示例：**
```json
{ "status": "ok", "timestamp": "2026-08-02T10:00:00.000Z" }
```

---

### 关于文件名与扩展名

**所有展示用的文件名字段都不含扩展名。** 上传 `notes.txt`，列表和详情接口返回的 `name` 就是 `notes`。

数据库和 R2 中始终保存**完整文件名**，剥离只发生在响应出口层，因此下载链路不受影响。

| 字段 | 所属接口 | 是否含扩展名 |
|------|----------|--------------|
| `data.name` | `POST /upload`、`GET /`、`GET /:id`、`PATCH /:id` | 否 |
| `data.files[].name` | `GET /`（列表） | 否 |
| `sourceFileName` | 全部 quiz 接口 | 否 |
| `Content-Disposition` 的 filename | `GET /:id/download` | **是** |
| `data.fileName` | `POST /presign/download/:id` | **是** |

剥离规则采用**扩展名白名单**：`txt` `md` `markdown` `pdf` `doc` `docx` `ppt` `pptx` `xls` `xlsx` `csv` `rtf` `html` `htm` `epub`。不在名单内的一律原样保留，避免误伤 `v1.2.3`、`第一季度.2024` 这类带点的普通文件名。仅剥离最后一段，`backup.2024.txt` → `backup.2024`。

**客户端注意事项：**

- 需要判断文件类型请用 `mimeType` 字段，不要解析 `name`
- 需要完整文件名（例如另存为）请用 `POST /presign/download/:id` 返回的 `fileName`
- 同目录下的 `a.txt` 和 `a.md` 会都显示为 `a`，用 `mimeType` 区分
- 重命名时传不带扩展名的新名字即可，服务端会自动补回原扩展名

实现见 `src/utils/filename.ts`。

---

### 上传格式白名单

服务器接受以下格式的**原始文档直传**，客户端无需转码：

- 文本：`text/plain`、`text/markdown`、`text/x-markdown`
- 文档：PDF、DOCX、XLSX（出题时由 AI Worker 服务端 `AI.toMarkdown` 转换）
- 图片：JPEG、PNG、WebP（出题时走服务端 OCR 通道）

其他格式一律返回 415。

---

### 上传文件（小文件，≤100MB）

```
POST /api/files/upload
```

上传前会做**存储配额检查**（已用 + 本次大小 > 配额上限时返回 429，见「存储配额」）。

支持两种方式：

#### 方式一：multipart/form-data

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | File | 是 | 文件内容 |
| path | string | 否 | 目标目录，默认 `/` |
| name | string | 否 | 自定义文件名，默认使用原始名 |

```bash
curl -X POST https://your-worker.workers.dev/api/files/upload \
  -H "Authorization: Bearer <jwt>" \
  -F "file=@notes.txt" \
  -F "path=/math/"
```

#### 方式二：原始二进制流

直接将文件内容作为请求体，通过 Header 传递元信息：

| Header | 必填 | 说明 |
|--------|------|------|
| X-File-Name | 是 | 文件名 |
| X-File-Path | 否 | 目标目录，默认 `/` |
| Content-Type | 否 | MIME 类型（必须在白名单内） |

```bash
curl -X POST https://your-worker.workers.dev/api/files/upload \
  -H "Authorization: Bearer <jwt>" \
  -H "X-File-Name: notes.txt" \
  -H "X-File-Path: /math/" \
  -H "Content-Type: text/plain" \
  --data-binary @notes.txt
```

**响应 (201)：**
```json
{
  "data": {
    "id": "a1b2c3d4-...",
    "name": "notes",
    "path": "/math/",
    "size": 102400,
    "mimeType": "text/plain",
    "hasThumbnail": false,
    "quizStatus": "none",
    "createdAt": "2026-08-02T10:00:00.000Z",
    "updatedAt": "2026-08-02T10:00:00.000Z"
  }
}
```

- `quizStatus`：`none`（从未出题）/ `generating`（生成中）/ `completed`（已成功）/ `failed`（失败）

**格式错误 (415)：**
```json
{ "error": "不支持的文件格式。当前支持：txt / markdown / PDF / docx / xlsx / jpg / png / webp" }
```

**配额超限 (429)：**
```json
{
  "error": {
    "code": "STORAGE_QUOTA_EXCEEDED",
    "message": "Storage quota exceeded",
    "quotaLimitBytes": 524288000,
    "currentUsageBytes": 520000000,
    "requestedBytes": 10000000
  }
}
```

---

### 列出文件

```
GET /api/files?path=/&page=1&limit=50&recursive=false
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| path | string | `/` | 目录路径 |
| recursive | boolean | false | 是否包含子目录 |
| page | number | 1 | 页码 |
| limit | number | 50 | 每页数量（最大 200） |

只返回 `confirmed` 状态的文件（预签名上传未确认的 `pending` 文件不会出现）。

**响应：**
```json
{
  "data": {
    "files": [
      {
        "id": "a1b2c3d4-...",
        "name": "homework",
        "path": "/math/",
        "size": 102400,
        "mimeType": "application/pdf",
        "hasThumbnail": false,
        "quizStatus": "completed",
        "createdAt": "2026-08-02T10:00:00.000Z",
        "updatedAt": "2026-08-02T10:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 50
  }
}
```

---

### 查询存储配额

```
GET /api/files/quota
```

**响应：**
```json
{
  "data": {
    "usedBytes": 104857600,
    "quotaLimitBytes": 524288000,
    "remainingBytes": 419430400
  }
}
```

配额上限来自订阅记录的 `storageLimit`；订阅缺失或查询失败时回退免费默认值 500 MB。

---

### 获取文件元信息

```
GET /api/files/:id
```

**响应：** 同上传响应结构（单个文件对象，`name` 已去扩展名）。

---

### 下载文件

```
GET /api/files/:id/download
```

返回文件二进制流，附带 `Content-Type` 和 `Content-Disposition` 头。

> `Content-Disposition` 中的文件名是**含扩展名的完整名**（如 `notes.txt`），
> 与 JSON 响应里的 `name` 字段（已去扩展名）语义不同。详见上方「关于文件名与扩展名」。

```bash
curl -O -J \
  -H "Authorization: Bearer <jwt>" \
  https://your-worker.workers.dev/api/files/a1b2c3d4-.../download
```

---

### 删除文件

```
DELETE /api/files/:id
```

同时删除 R2 对象（含缩略图）和 D1 记录。

**响应：**
```json
{ "data": { "deleted": true, "id": "a1b2c3d4-..." } }
```

---

### 重命名 / 移动文件

```
PATCH /api/files/:id
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 否 | 新文件名（可不带扩展名，服务端会自动补回原扩展名） |
| path | string | 否 | 新目录路径 |

至少提供一个字段。

```bash
curl -X PATCH https://your-worker.workers.dev/api/files/a1b2c3d4-... \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "final-homework", "path": "/math/semester1/"}'
```

**响应：** 返回更新后的文件元信息（`name` 已去扩展名）。

> 传 `"final-homework"`（不带扩展名）时，服务端会自动补回原文件的扩展名再入库，
> 实际存储为 `final-homework.pdf`。若你显式传了 `"final-homework.md"`，则以你传的为准。

---

### 缩略图

```
POST /api/files/:id/thumbnail
```

上传/更新文件缩略图。请求体为图片二进制流（任意 `image/*`，常用 webp / jpeg / png），客户端负责生成缩略图，服务端只负责存储。

**响应 (201)：**
```json
{ "data": { "fileId": "...", "thumbnailKey": "...", "contentType": "image/webp" } }
```

```
GET /api/files/:id/thumbnail
```

流式返回缩略图图片（带 24 小时缓存头）。无缩略图时返回 404。

---

### 大文件上传（>100MB，预签名 URL）

分三步完成：

#### 第一步：获取上传链接

```
POST /api/files/presign/upload
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 文件名 |
| size | number | 是 | 文件大小（字节） |
| path | string | 否 | 目标目录 |
| mimeType | string | 否 | MIME 类型（必须在白名单内） |

签发前会做存储配额检查（按声明的 `size` 计），超限返回 429（结构同上传接口）。

**响应：**
```json
{
  "data": {
    "uploadUrl": "https://xxx.r2.cloudflarestorage.com/...",
    "fileId": "a1b2c3d4-...",
    "r2Key": "userId/path/fileId",
    "expiresIn": 900,
    "headers": { "Content-Type": "application/pdf" }
  }
}
```

#### 第二步：客户端直传 R2

```bash
curl -X PUT "<uploadUrl>" \
  -H "Content-Type: application/pdf" \
  --data-binary @large-doc.pdf
```

#### 第三步：确认上传完成

```
POST /api/files/presign/confirm/:fileId
```

**必须调用**，否则文件保持 `pending` 状态，不会出现在文件列表中。服务端会校验 R2 中对象存在且大小与声明一致。

**响应：**
```json
{ "data": { "fileId": "a1b2c3d4-...", "status": "confirmed" } }
```

---

### 大文件下载（预签名 URL）

```
POST /api/files/presign/download/:id
```

**响应：**
```json
{
  "data": {
    "downloadUrl": "https://xxx.r2.cloudflarestorage.com/...",
    "expiresIn": 900,
    "fileName": "large-doc.pdf",
    "mimeType": "application/pdf"
  }
}
```

客户端直接 GET 该 URL 即可下载，无需再带 Authorization 头。

---

## 错误响应格式

普通错误返回统一格式：

```json
{ "error": "错误描述信息" }
```

配额类错误返回结构化对象（见上传接口的 429 示例）：

```json
{ "error": { "code": "...", "message": "...", ... } }
```

| 状态码 | 含义 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未认证或 token 无效/过期 |
| 404 | 资源不存在 |
| 415 | 文件格式不支持 |
| 429 | 存储配额 / AI 用量配额超限 |
| 500 | 服务器内部错误 |
| 502 | 依赖服务（OCR / 用量）不可用 |
| 503 | Appwrite 认证服务 / AI 服务不可用 |

---

## 桌面客户端集成要点（文件模块）

1. 用户登录后调用 Appwrite 的 `CreateJWT()` 获取 token
2. 将 token 存储在本地
3. 每次 API 请求携带 `Authorization: Bearer <token>`
4. JWT 过期后需重新调用 `CreateJWT()` 刷新
5. 小文件（≤100MB）直接 POST 到 `/api/files/upload`（原始文档直传，无需转码）
6. 大文件（>100MB）先请求预签名 URL，PUT 直传后**必须**调 `/presign/confirm/:fileId`
7. 上传前可先调 `GET /api/files/quota` 预判配额

---

## We Quiz API

We Quiz 模块管理结构化题目、作答记录和毕业判定，以 **Quiz** 为聚合根（Document 1:1 Quiz，Quiz 1:N Questions）。

### 认证方式

We Quiz 有两种认证方式：

- **用户 JWT**：桌面客户端使用，`Authorization: Bearer <jwt>`
- **Ticket**：AI Worker 使用，`X-Quiz-Ticket: <ticket>`（服务端创建 session 时生成并直接传给 AI Worker，客户端不可见）

---

### 数据模型

```
Document (files 表) ──1:1── Quiz (quizzes 表) ──1:N── Questions (questions 表)
                                                            │
                                                    1:N ───┘
                                                            │
                                                    AnswerRecords
```

- **Quiz**：一次出题的持久化结果。创建 session 时同步创建，status 随 AI Worker 回调自动流转（`generating` → `completed` / `failed`）
- **问题**：每道题关联到一个 Quiz，自带毕业统计字段（`consecutive_correct` / `graduated`）
- **毕业判定**：**服务端计算**——连续答对 3 次即毕业（`graduated = 1`，终态，不再降级）。没有艾宾浩斯/SM-2 调度

---

### AI 转换完整链路

客户端全程只与本 API 通信，接触不到 AI Worker——AI Worker 没有公网入口，本 API 通过 Service Binding 内部直连它。**原始文档直传**：PDF / DOCX / XLSX / 图片的转换全部由 AI Worker 服务端完成。

```
① 客户端 → 上传原始文档（POST /api/files/upload，白名单格式）→ 拿到 fileId
② 客户端 → POST /api/quiz/sessions (JWT)        → 后台创建 Quiz + session，获得 quizId
   （触发前做 AI 用量配额检查，超限返回 429 QUOTA_EXCEEDED）
③ 本 API  → Service Binding 调 AI Worker /api/quiz/generate → 传 { ticket, userId, materials: [{ r2Key, mimeType }] }
④ AI Worker → PATCH /api/quiz/sessions/:id/status (ticket) → 标记 processing，同步更新 quizzes
⑤ AI Worker → 直接读 R2（r2Key）→ 格式分诊：
              文本直读；PDF/DOCX/XLSX 走 toMarkdown；
              扫描件 PDF 分块抽页图 OCR；图片走 OCR
⑥ AI Worker → 内容审核（输入侧语料 + 输出侧题目，fail-closed）
⑦ AI Worker → 调用生成模型（规划 + 分批生成）→ 获得结构化题目
⑧ AI Worker → POST /api/quiz/questions/batch (ticket) → 入库挂 quizId，quiz 自动标记 completed
⑨ 客户端 → GET /api/quiz/sessions/:id 轮询状态 → completed 后通过 quizId 拉取题目
```

失败时 session / quiz 置为 `failed` 并携带 `failReason`（内容审核原因码：`CONTENT_BLOCKED` / `CONTENT_REVIEW_PENDING` / `CONTENT_SCAN_UNAVAILABLE`），客户端可据此展示文案并支持重试。

---

### Quiz 管理

#### 获取 Quiz 列表

```
GET /api/quiz/quizzes
Authorization: Bearer <jwt>
```

**响应：**
```json
{
  "data": [
    {
      "id": "quiz-uuid",
      "name": "math-chapter3",
      "sourceFileId": "file-uuid",
      "sourceFileName": "math-chapter3",
      "totalQuestions": 25,
      "graduatedQuestions": 8,
      "status": "completed",
      "createdAt": "2026-08-02T10:00:00.000Z",
      "updatedAt": "2026-08-02T10:01:30.000Z"
    }
  ]
}
```

- `graduatedQuestions`：连续答对 3 次已毕业的题数
- status：`generating` / `completed` / `failed`

#### 获取单个 Quiz 详情

```
GET /api/quiz/quizzes/:id
Authorization: Bearer <jwt>
```

响应结构同上（单对象）。

#### 重命名 Quiz

```
PATCH /api/quiz/quizzes/:id
Authorization: Bearer <jwt>
Content-Type: application/json
```

```json
{ "name": "高等数学第三章" }
```

**响应：**
```json
{ "data": { "id": "quiz-uuid", "name": "高等数学第三章" } }
```

#### 删除 Quiz

```
DELETE /api/quiz/quizzes/:id
Authorization: Bearer <jwt>
```

级联删除关联的所有作答记录、题目、会话和 Quiz。

**响应：**
```json
{ "data": { "deleted": true, "id": "quiz-uuid" } }
```

#### 获取 Quiz 下的题目

```
GET /api/quiz/quizzes/:id/questions?graduated=false&type=single_answer&page=1&limit=20
Authorization: Bearer <jwt>
```

查询参数同 `GET /api/quiz/questions`，但不需传 `quizId`（已由路径指定）。

---

### 图片转文字（OCR，异步）

```
POST /api/quiz/ocr
Authorization: Bearer <jwt>
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| images | array | 是 | 1~15 项，每项 `{ data: base64, mimeType: image/jpeg/image/png/image/webp }`，单张 ≤4MB |

**异步流程**：AI Worker 接收后立即返回 202 和 `taskId`，实际 OCR 由 Durable Object 分批处理，客户端轮询结果。触发前做 AI 用量配额检查。

**响应 (202)：**
```json
{ "data": { "taskId": "ocr_...", "status": "processing" } }
```

#### 轮询 OCR 结果

```
GET /api/quiz/ocr/status/:taskId
Authorization: Bearer <jwt>
```

**响应：**

- 处理中：`{ "data": { "status": "processing", "progress": { "batch": 1, "total": 3 } } }`
- 完成：`{ "data": { "status": "done", "text": "转录出来的文字" } }`
- 失败：`{ "data": { "status": "failed", "error": "..." } }`（500）
- 图片中无可识别文字：422

---

### 创建 Quiz Session

创建 session 的同时，服务端会同步创建 Quiz 实体（status=`generating`），并触发 AI Worker 开始出题。客户端不需要（也无法）接触 AI Worker。

```
POST /api/quiz/sessions
Authorization: Bearer <jwt>
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceFileId | string | 是 | 要转换的文档 ID（files 表中的 id） |

```bash
curl -X POST https://your-worker.workers.dev/api/quiz/sessions \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"sourceFileId": "file-uuid-here"}'
```

**响应 (201)：**
```json
{
  "data": {
    "quizId": "a1b2c3d4-...",
    "sessionId": "a1b2c3d4-...",
    "sourceFileName": "math-chapter3",
    "status": "generating",
    "expiresIn": 1800
  }
}
```

- 同时创建 Quiz 和 session，两者 id 相同（quizId === sessionId）
- 源文档格式不在白名单内时返回 415
- 触发前做 AI 用量配额检查，超限返回 429（`code: QUOTA_EXCEEDED`）
- 若 AI Worker 触发失败，Quiz 和 session 会被自动清理并返回 503 `AI 服务暂时不可用，请稍后重试`
- session 有效期 30 分钟（长任务中 AI Worker 会自动续期），用 `quizId` 通过下方"查询 Session 状态"接口轮询进度

**重试语义**（同一文档再次调用时）：

| 已有 Quiz 状态 | 行为 |
|----------------|------|
| `generating` | 直接返回已有 quizId（200），不重复触发 |
| `completed` | 直接返回已有 quizId（200） |
| `failed` | 清理残留题目 → 重置为 `generating` → 新建 session → 重新触发 AI |

---

### 查询 Session 状态

```
GET /api/quiz/sessions/:id
Authorization: Bearer <jwt>
```

**响应（session 存在）：**
```json
{
  "data": {
    "quizId": "a1b2c3d4-...",
    "sessionId": "a1b2c3d4-...",
    "sourceFileId": "file-uuid",
    "status": "completed",
    "failReason": null,
    "createdAt": "2026-08-02T10:00:00.000Z",
    "completedAt": "2026-08-02T10:01:30.000Z",
    "expiresAt": "2026-08-02T10:30:00.000Z"
  }
}
```

status 取值：`pending` → `processing` → `completed` / `failed`

- `failReason`：仅 failed 时非空，取值 `CONTENT_BLOCKED` / `CONTENT_REVIEW_PENDING` / `CONTENT_SCAN_UNAVAILABLE`
- session 过期清理后仍可通过 quizId 查到 Quiz 状态（响应只含 `quizId`、`sourceFileName`、`status`、`failReason`、`createdAt`）

---

### 取消出题任务

```
POST /api/quiz/sessions/:id/cancel
Authorization: Bearer <jwt>
```

仅 `pending` / `processing` 状态可取消（其他状态返回 409）。将 session 和 quiz 置为 `failed`，AI Worker 下次续期 ticket 时收到 4xx 即中止。

**响应：**
```json
{ "data": { "sessionId": "...", "status": "failed" } }
```

---

### 更新 Session 状态（AI Worker 用）

```
PATCH /api/quiz/sessions/:id/status
X-Quiz-Ticket: <ticket>
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 是 | `processing` / `completed` / `failed` |
| reason | string | 否 | 仅 `failed` 时可携带，限 `CONTENT_BLOCKED` / `CONTENT_REVIEW_PENDING` / `CONTENT_SCAN_UNAVAILABLE` |

同步更新 quiz_sessions 与 quizzes 两张表。

---

### 续期 Ticket（AI Worker 用）

```
POST /api/quiz/sessions/:id/renew
X-Quiz-Ticket: <ticket>
```

将 `expires_at` 往后推 30 分钟，防止长时生成任务中途过期。已取消/已完成的 session 返回 4xx（AI Worker 据此检测取消信号并中止）。

---

### 批量上传题目（AI Worker 用）

```
POST /api/quiz/questions/batch
X-Quiz-Ticket: <ticket>
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| questions | array | 是 | 题目数组（最多 500 条） |

每道题的结构：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 是 | 题型标识（如 single_answer, true_false, fill_blank） |
| content | object | 是 | 题目内容（JSON，结构随题型变化） |
| answer | object | 是 | 正确答案（JSON） |
| tags | string[] | 否 | 标签 |

五种题型（`single_answer` 单选、`multiple_answer` 多选、`true_false` 判断、`fill_blank` 填空、`short_answer` 简答）：

```json
{
  "questions": [
    {
      "type": "single_answer",
      "content": { "stem": "2+2等于?", "options": ["3", "4", "5", "6"] },
      "answer": { "correctIndex": 1 },
      "tags": ["数学"]
    },
    {
      "type": "true_false",
      "content": { "stem": "地球是平的" },
      "answer": { "correct": false }
    },
    {
      "type": "fill_blank",
      "content": { "stem": "法国的首都是___" },
      "answer": { "correct": ["巴黎"], "accept": [["巴黎", "Paris"]] }
    }
  ]
}
```

**响应 (201)：**
```json
{
  "data": {
    "inserted": 3,
    "quizId": "session-uuid"
  }
}
```

上传成功后 Quiz 和 session 状态同时变为 `completed`。

---

### 获取题目列表

```
GET /api/quiz/questions?quizId=xxx&graduated=false&page=1&limit=20
Authorization: Bearer <jwt>
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| quizId | string | - | 按 Quiz 过滤 |
| tags | string | - | 逗号分隔标签（匹配任一） |
| graduated | string | - | `true` 只返回已毕业，`false` 只返回未毕业，不传返回全部 |
| type | string | - | 按题型过滤 |
| page | number | 1 | 页码 |
| limit | number | 50 | 每页数量（最大 200） |

**响应：**
```json
{
  "data": {
    "questions": [
      {
        "id": "uuid-1",
        "quizId": "quiz-uuid",
        "type": "single_answer",
        "content": { "stem": "2+2等于?", "options": ["3", "4", "5", "6"] },
        "answer": { "correctIndex": 1 },
        "tags": ["数学"],
        "stats": {
          "consecutiveCorrect": 0,
          "graduated": 0
        },
        "createdAt": "2026-08-02T10:00:00.000Z",
        "updatedAt": "2026-08-02T10:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
}
```

也可以使用 `GET /api/quiz/quizzes/:id/questions` 按指定 Quiz 拉取题目。

---

### 获取单题详情

```
GET /api/quiz/questions/:id
Authorization: Bearer <jwt>
```

响应结构同列表中单个 question 对象。

---

### 删除题目

```
DELETE /api/quiz/questions/:id
Authorization: Bearer <jwt>
```

同时删除该题的所有作答记录。

**响应：**
```json
{ "data": { "deleted": true, "id": "uuid-1" } }
```

---

### 提交作答记录（服务端算毕业）

```
POST /api/quiz/answers
Authorization: Bearer <jwt>
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| answers | array | 是 | 作答数组（最多 500 条） |

每条作答的结构：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| questionId | string | 是 | 题目 ID |
| isCorrect | boolean | 是 | 是否答对 |
| userAnswer | any | 否 | 用户的实际答案（JSON，仅审计记录用） |

**请求示例：**
```json
{
  "answers": [
    { "questionId": "uuid-1", "isCorrect": true, "userAnswer": { "selectedIndex": 1 } },
    { "questionId": "uuid-2", "isCorrect": false, "userAnswer": { "selectedIndex": 0 } }
  ]
}
```

**响应 (201)：**
```json
{ "data": { "recorded": 2 } }
```

**毕业判定（服务端完成）**：每题答对 `consecutive_correct` +1，答错归 0；连续答对满 3 次标记 `graduated = 1`（终态，已毕业不再降级）。客户端**不需要**计算任何调度算法，也**不传**调度字段。

---

## 用量查询

```
GET /usage?ym=YYYY-MM（可选，默认本月，北京时间自然月）
Authorization: Bearer <jwt>
```

返回当前用户指定月份的 AI 用量（聚合在 AI Worker 完成，查 AI Gateway 日志）。userId 取自 JWT，客户端无法查询他人。

**响应：**
```json
{
  "data": {
    "month": "2026-08",
    "requests": 42,
    "cost": 0.123456,
    "tokensIn": 120000,
    "tokensOut": 35000
  }
}
```

- `cost` 单位 USD
- AI 用量配额检查（`POST /api/quiz/sessions` 与 `POST /api/quiz/ocr` 触发前）：当月 `cost` ≥ 订阅 `quotaLimit` 时返回 429（`code: QUOTA_EXCEEDED`）；订阅缺失时回退免费额度 0.5 USD

---

## We Quiz 桌面客户端集成要点

1. 上传文档用 `POST /api/files/upload`：白名单格式（txt / md / PDF / docx / xlsx / jpg / png / webp）原始直传，**客户端无需转码**
2. 出题只需调 `POST /api/quiz/sessions`（传 sourceFileId），服务端会自动创建 Quiz 并触发 AI Worker，响应含 quizId
3. 通过 `GET /api/quiz/sessions/:id` 轮询转换进度，completed 后 Quiz 即就绪；failed 时读 `failReason` 展示文案，可直接重新调 `POST /api/quiz/sessions` 重试
4. 进行中可用 `POST /api/quiz/sessions/:id/cancel` 取消
5. 客户端不需要知道 AI Worker 的存在，ticket / r2Key / 内部令牌均为服务端内部凭证
6. 通过 `GET /api/quiz/quizzes` 查看所有 Quiz 及毕业进度（`graduatedQuestions` / `totalQuestions`）
7. 刷题时调 `GET /api/quiz/quizzes/:id/questions?graduated=false&limit=N` 拉取未毕业题目
8. 作答后调 `POST /api/quiz/answers` 批量提交（只传 questionId / isCorrect / userAnswer），毕业判定由服务端完成
9. 独立 OCR 需求（如上传前预览识别效果）走 `POST /api/quiz/ocr` + `GET /api/quiz/ocr/status/:taskId` 异步轮询
