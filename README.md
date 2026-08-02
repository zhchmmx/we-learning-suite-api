# we-learning-suite-api

基于 Cloudflare Workers 的学习套件后端 API，使用 Appwrite JWT 鉴权，R2 存储文件本体，D1 存储元数据。包含文件管理和 We Quiz（题目存储 + 作答记录 + 艾宾浩斯调度）两大模块。

## 技术栈

- **运行时**: Cloudflare Workers
- **路由**: Hono
- **存储**: R2（文件本体）+ D1（元数据）
- **鉴权**: Appwrite JWT（通过 Appwrite REST API 验证）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

编辑 `wrangler.jsonc`，填入：

- `APPWRITE_ENDPOINT`: 你的 Appwrite endpoint（如 `https://cloud.appwrite.io/v1`）
- `APPWRITE_PROJECT_ID`: 你的 Appwrite 项目 ID
- D1 的 `database_id`: 在 Cloudflare 控制台 → D1 → 你的数据库 → Settings 中获取

### 3. 设置 Secrets

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
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

### 6. 部署

```bash
npx wrangler deploy
```

---

## API 文档

所有 `/api/files` 下的接口都需要在请求头中携带 Appwrite JWT：

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

### 上传文件（小文件，≤100MB）

```
POST /api/files/upload
```

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
  -F "file=@homework.pdf" \
  -F "path=/math/"
```

#### 方式二：原始二进制流

直接将文件内容作为请求体，通过 Header 传递元信息：

| Header | 必填 | 说明 |
|--------|------|------|
| X-File-Name | 是 | 文件名 |
| X-File-Path | 否 | 目标目录，默认 `/` |
| Content-Type | 否 | MIME 类型 |

```bash
curl -X POST https://your-worker.workers.dev/api/files/upload \
  -H "Authorization: Bearer <jwt>" \
  -H "X-File-Name: homework.pdf" \
  -H "X-File-Path: /math/" \
  -H "Content-Type: application/pdf" \
  --data-binary @homework.pdf
```

**响应 (201)：**
```json
{
  "data": {
    "id": "a1b2c3d4-...",
    "name": "homework.pdf",
    "path": "/math/",
    "size": 102400,
    "mimeType": "application/pdf",
    "createdAt": "2026-08-02T10:00:00.000Z",
    "updatedAt": "2026-08-02T10:00:00.000Z"
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

**响应：**
```json
{
  "data": {
    "files": [
      {
        "id": "a1b2c3d4-...",
        "name": "homework.pdf",
        "path": "/math/",
        "size": 102400,
        "mimeType": "application/pdf",
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

### 获取文件元信息

```
GET /api/files/:id
```

**响应：**
```json
{
  "data": {
    "id": "a1b2c3d4-...",
    "name": "homework.pdf",
    "path": "/math/",
    "size": 102400,
    "mimeType": "application/pdf",
    "createdAt": "2026-08-02T10:00:00.000Z",
    "updatedAt": "2026-08-02T10:00:00.000Z"
  }
}
```

---

### 下载文件

```
GET /api/files/:id/download
```

返回文件二进制流，附带 `Content-Type` 和 `Content-Disposition` 头。

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
| name | string | 否 | 新文件名 |
| path | string | 否 | 新目录路径 |

至少提供一个字段。

```bash
curl -X PATCH https://your-worker.workers.dev/api/files/a1b2c3d4-... \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "final-homework.pdf", "path": "/math/semester1/"}'
```

**响应：** 返回更新后的文件元信息。

---

### 大文件上传（>100MB，预签名 URL）

分两步完成：

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
| mimeType | string | 否 | MIME 类型 |

**响应：**
```json
{
  "data": {
    "uploadUrl": "https://xxx.r2.cloudflarestorage.com/...",
    "fileId": "a1b2c3d4-...",
    "r2Key": "userId/path/fileId",
    "expiresIn": 900,
    "headers": { "Content-Type": "video/mp4" }
  }
}
```

#### 第二步：客户端直传 R2

```bash
curl -X PUT "<uploadUrl>" \
  -H "Content-Type: video/mp4" \
  --data-binary @large-video.mp4
```

上传完成后文件即可通过 `/api/files/:fileId` 访问。

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
    "fileName": "large-video.mp4",
    "mimeType": "video/mp4"
  }
}
```

客户端直接 GET 该 URL 即可下载，无需再带 Authorization 头。

---

## 错误响应格式

所有错误返回统一格式：

```json
{ "error": "错误描述信息" }
```

| 状态码 | 含义 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未认证或 token 无效/过期 |
| 404 | 文件不存在 |
| 500 | 服务器内部错误 |
| 503 | Appwrite 认证服务不可用 |

---

## 桌面客户端集成要点

1. 用户登录后调用 Appwrite 的 `CreateJWT()` 获取 token
2. 将 token 存储在本地
3. 每次 API 请求携带 `Authorization: Bearer <token>`
4. JWT 过期后需重新调用 `CreateJWT()` 刷新
5. 小文件（≤100MB）直接 POST 到 `/api/files/upload`
6. 大文件（>100MB）先请求预签名 URL，再 PUT 直传

---

## We Quiz API

We Quiz 模块管理结构化题目、作答记录和艾宾浩斯复习调度。

### 认证方式

We Quiz 有两种认证方式：

- **用户 JWT**：桌面客户端使用，`Authorization: Bearer <jwt>`
- **Ticket**：AI Worker 使用，`X-Quiz-Ticket: <ticket>`（通过创建 session 获取）

---

### AI 转换完整链路

```
① 客户端 → POST /api/quiz/sessions (JWT)     → 获得 ticket + downloadUrl
② 客户端 → 将 ticket + downloadUrl 传给 AI Worker
③ AI Worker → GET downloadUrl                  → 下载源文档
④ AI Worker → 调用 AI 服务                     → 获得结构化题目
⑤ AI Worker → PATCH /api/quiz/sessions/:id/status (ticket) → 标记 processing
⑥ AI Worker → POST /api/quiz/questions/batch (ticket)      → 上传题目
```

---

### 创建 Quiz Session

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
    "ticket": "a1b2c3d4-...",
    "downloadUrl": "https://xxx.r2.cloudflarestorage.com/...",
    "sourceFileName": "math-chapter3.pdf",
    "expiresIn": 1800
  }
}
```

ticket 有效期 30 分钟，只能用于该 session 对应的操作。

---

### 查询 Session 状态

```
GET /api/quiz/sessions/:id
Authorization: Bearer <jwt>
```

**响应：**
```json
{
  "data": {
    "id": "a1b2c3d4-...",
    "sourceFileId": "file-uuid",
    "status": "completed",
    "createdAt": "2026-08-02T10:00:00.000Z",
    "completedAt": "2026-08-02T10:01:30.000Z",
    "expiresAt": "2026-08-02T10:30:00.000Z"
  }
}
```

status 取值：`pending` → `processing` → `completed` / `failed`

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
| type | string | 是 | 题型标识（如 single_choice, true_false, fill_blank） |
| content | object | 是 | 题目内容（JSON，结构随题型变化） |
| answer | object | 是 | 正确答案（JSON） |
| tags | string[] | 否 | 标签 |

**请求示例：**
```json
{
  "questions": [
    {
      "type": "single_choice",
      "content": { "stem": "2+2等于?", "options": ["3", "4", "5", "6"] },
      "answer": { "correctIndex": 1 },
      "tags": ["数学", "基础运算"]
    },
    {
      "type": "true_false",
      "content": { "stem": "地球是平的" },
      "answer": { "correct": false }
    },
    {
      "type": "fill_blank",
      "content": { "stem": "法国的首都是___" },
      "answer": { "correct": "巴黎", "accept": ["巴黎", "Paris"] }
    }
  ]
}
```

**响应 (201)：**
```json
{
  "data": {
    "inserted": 3,
    "questionIds": ["uuid-1", "uuid-2", "uuid-3"],
    "sessionId": "session-uuid"
  }
}
```

上传成功后 session 状态自动变为 `completed`。

---

### 获取题目列表

```
GET /api/quiz/questions?due=true&page=1&limit=20
Authorization: Bearer <jwt>
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| sourceFileId | string | - | 按来源文档过滤 |
| tags | string | - | 逗号分隔标签（匹配任一） |
| due | boolean | false | 只返回到期题目（next_review_at ≤ 当前时间） |
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
        "sourceFileId": "file-uuid",
        "type": "single_choice",
        "content": { "stem": "2+2等于?", "options": ["3", "4", "5", "6"] },
        "answer": { "correctIndex": 1 },
        "tags": ["数学"],
        "schedule": {
          "easeFactor": 2.5,
          "interval": 0,
          "repetitions": 0,
          "nextReviewAt": "2026-08-02T10:00:00.000Z",
          "lastReviewedAt": null
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

**离线刷题建议**：客户端联网时用 `?due=true&limit=20` 拉取一批到期题目缓存到本地，离线时本地出题，联网后同步作答结果。

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

### 提交作答记录 + 更新调度

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
| userAnswer | any | 否 | 用户的实际答案（JSON） |
| newSchedule | object | 是 | 客户端计算的新调度状态 |
| newSchedule.easeFactor | number | 是 | 新难度系数 |
| newSchedule.interval | number | 是 | 新间隔天数 |
| newSchedule.repetitions | number | 是 | 新连续答对次数 |
| newSchedule.nextReviewAt | string | 是 | 新下次复习时间（ISO） |

**请求示例：**
```json
{
  "answers": [
    {
      "questionId": "uuid-1",
      "isCorrect": true,
      "userAnswer": { "selectedIndex": 1 },
      "newSchedule": {
        "easeFactor": 2.6,
        "interval": 1,
        "repetitions": 1,
        "nextReviewAt": "2026-08-03T10:00:00.000Z"
      }
    },
    {
      "questionId": "uuid-2",
      "isCorrect": false,
      "userAnswer": { "selectedIndex": 0 },
      "newSchedule": {
        "easeFactor": 2.3,
        "interval": 0,
        "repetitions": 0,
        "nextReviewAt": "2026-08-02T10:10:00.000Z"
      }
    }
  ]
}
```

**响应 (201)：**
```json
{ "data": { "recorded": 2 } }
```

**调度说明**：Worker 不计算艾宾浩斯算法，只负责存储。客户端答完题后本地运行 SM-2（或 FSRS）公式，将计算结果通过此接口同步到服务端。

---

## We Quiz 桌面客户端集成要点

1. 触发 AI 转换前，先调 `POST /api/quiz/sessions` 获取 ticket + downloadUrl
2. 将 ticket 和 downloadUrl 传给 AI Worker，由 AI Worker 完成下载→转换→上传
3. 可通过 `GET /api/quiz/sessions/:id` 轮询转换进度
4. 刷题时调 `GET /api/quiz/questions?due=true&limit=N` 拉取到期题目
5. 离线时本地缓存题目和调度状态，联网后通过 `POST /api/quiz/answers` 批量同步
6. 调度算法（SM-2/FSRS）完全在客户端实现，服务端只存状态
