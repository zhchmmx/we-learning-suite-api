# we-learning-suite-api

基于 Cloudflare Workers 的文件存储 API，使用 Appwrite JWT 鉴权，R2 存储文件本体，D1 存储元数据。

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
