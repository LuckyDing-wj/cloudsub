# CloudSub

> 部署在 Cloudflare Workers 上的订阅节点管理与分发系统。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LYISTR2/Cloudsub)

## 功能概览

- **一键部署** — 从 GitHub 部署到自己的 Cloudflare 账户
- **多源导入** — 支持订阅 URL、手动粘贴配置文件，加密存储敏感数据
- **智能解析** — 自动识别 Base64、Clash YAML、URI 列表、内部 JSON 格式
- **节点处理** — 解析、去重（指纹）、分组、过滤、正则重命名、排序
- **多格式输出** — Mihomo (Clash Meta) / Sing-box / Raw Base64 / JSON
- **订阅令牌** — 带访问令牌的订阅地址，支持过期时间和令牌轮换
- **定时刷新** — Cron（默认 `*/30 * * * *`）定时拉取上游订阅，自动更新缓存；失败的数据源按指数退避延后（30 秒起，封顶 6 小时），避免拖垮队列
- **管理后台** — 轻量 SPA 管理界面，支持数据源、节点、订阅、审计日志管理
- **安全防护** — SSRF 防护 + DNS 预解析、AES-GCM 加密、PBKDF2 密码哈希、CSRF 保护、D1 计数限流

## 支持的协议

| 协议 | URI 解析 | Clash YAML 解析 | Sing-box 输出 |
|------|---------|----------------|--------------|
| Shadowsocks (ss) | ✅ | ✅ | ✅ |
| VMess | ✅ | ✅ | ✅ |
| VLESS | ✅ | ✅ | ✅ |
| Trojan | ✅ | ✅ | ✅ |
| Hysteria2 | ✅ | ✅ | ✅ |
| TUIC | ✅ | ✅ | ✅ |
| AnyTLS | ✅ | ✅ | ✅ |

## 支持的输出格式

| 格式 | target 参数 | 说明 |
|------|-----------|------|
| **Mihomo / Clash Meta** | `mihomo` | 完整 YAML 配置，含 proxy-groups（自动选择 / 手动选择）和分流规则（AI / Telegram / 流媒体 / Apple / 国内直连） |
| **Sing-box** | `singbox` | 完整 JSON 配置，含 outbounds（selector / urltest / direct / dns）、DNS 分流、路由规则 |
| **Raw Base64** | `raw` | 标准 Base64 编码的 URI 列表，保留全部传输参数（ws path / host / flow / alpn / obfs 等） |
| **JSON** | `json` | 内部 NormalizedNode JSON，供 API 对接使用 |

## 快速部署

### Cloudflare 一键部署

点击 README 顶部的 **Deploy to Cloudflare** 按钮，登录 Cloudflare 后按向导完成部署：Cloudflare 会从本仓库创建项目，构建前端、应用 D1 migrations 后发布 Worker。

> **部署前必做**：`wrangler.jsonc` 中的 `database_id` 与 KV `id` 是**账号专属**的。仓库里提交的是维护者账号的资源 ID，直接部署会报
> `D1 binding 'DB' references database '<id>' which was not found [code: 10181]`（KV 同理）。
> 请先替换成自己账号的资源 ID：
> ```bash
> npx wrangler d1 create cloudsub          # 复制 database_id
> npx wrangler kv namespace create CACHE   # 复制 id
> ```

部署向导会要求配置两个互不相同的随机密钥：

- `APP_SECRET` — 会话与订阅令牌的 HMAC 密钥
- `DATA_ENCRYPTION_KEY` — 数据源敏感内容的 AES-GCM 加密密钥

可选环境变量：

| 变量 | 说明 |
|------|------|
| `INITIAL_ADMIN_TOKEN` | 为首次初始化增加一层部署侧验证（必须填对才能创建管理员） |
| `SSRF_DNS_CHECK` | 设为 `0` 可关闭上游地址的 DNS 预解析校验（默认开启） |

除上述密钥外，`wrangler.jsonc` 的 `vars` 还包含 `APP_NAME` / `SESSION_TTL` / `SUB_CACHE_TTL` / `MAX_SOURCE_SIZE`，按需调整。

部署完成后访问生成的 `workers.dev` 地址创建管理员账户。健康检查地址：`GET /health`。

### 手动部署

#### 前置条件

- Cloudflare 账户
- Node.js 22+
- npm

#### 步骤

1. **Fork / Clone 本仓库**

2. **安装依赖**
   ```bash
   npm ci
   ```

3. **配置 Secrets**
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   编辑 `.dev.vars`，填入：
   ```
   APP_SECRET=<随机32字节密钥>
   DATA_ENCRYPTION_KEY=<随机32字节密钥>
   ```
   生成密钥：`openssl rand -base64 32`

4. **创建 Cloudflare 资源**
   ```bash
   npx wrangler d1 create cloudsub
   npx wrangler kv namespace create CACHE
   ```
   将返回的 ID 填入 `wrangler.jsonc`。

5. **运行数据库迁移**
   ```bash
   npx wrangler d1 migrations apply cloudsub
   ```

6. **部署**
   ```bash
   npm run deploy
   ```
   脚本会构建前端 → 应用 D1 migrations → 发布 Worker（含 `wrangler.jsonc` 中配置的 cron 触发器）。
   **注意**：Workers 免费版每个账号的 cron 触发器上限为 5 个，占满时部署会报
   `code: 10072`，需要先释放其他 Worker 的 cron 或在面板手动添加触发器。

7. **初始化管理员**
   访问部署后的 URL，首次进入会提示创建管理员账户。

### GitHub Actions 自动部署

仓库已内置两个 workflow：

- `ci.yml` — 推送到 `main` 或提交 PR 时自动运行 lint、类型检查、测试与构建
- `deploy.yml` — 手动触发（`workflow_dispatch`），执行 `npm run build` → `wrangler d1 migrations apply DB --remote` → `wrangler deploy`

在仓库 Settings → Secrets and variables → Actions 中配置：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

然后在 Actions 页面选择 **Deploy to Cloudflare** → Run workflow。

## 订阅地址格式

```
https://<your-worker>.workers.dev/sub/<token>?target=mihomo
```

| 参数 | 说明 |
|------|------|
| `token` | 订阅访问令牌（创建订阅时生成） |
| `target` | 可选，`mihomo` / `singbox` / `raw` / `json`，默认使用订阅配置的 `defaultTarget` |

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1 (SQLite) |
| 缓存 | Cloudflare KV |
| 后端框架 | Hono |
| 前端 | React + Vite |
| ORM / 迁移 | Drizzle ORM |
| 校验 | Zod |
| 加密 | Web Crypto API (AES-GCM, PBKDF2, HMAC-SHA256) |

## 安全特性

- **SSRF 防护** — 拦截私有 IP (10.x / 127.x / 169.254.x / 172.16-31.x / 192.168.x)、链路本地、保留地址；归一化十进制/十六进制/八进制/短式 IPv4 编码；识别 IPv4-mapped、IPv4-compatible 与 NAT64 IPv6 中内嵌的 IPv4；强制 HTTPS；重定向重新校验
- **DNS 预解析** — 拉取上游前用 DoH 解析主机名并校验全部 A/AAAA 记录，阻断 DNS rebinding（公网域名指向 127.0.0.1 / 169.254.169.254 的情况）；结果在 KV 缓存 5 分钟
- **数据加密** — 数据源的 URL、请求头、内容使用 AES-256-GCM 加密存储
- **密码哈希** — PBKDF2-SHA256，100,000 次迭代（Cloudflare Workers WebCrypto 的 PBKDF2 上限为 10 万次）
- **会话管理** — HMAC 存储的 session token，HttpOnly + Secure + SameSite=Strict cookie
- **CSRF 保护** — 双重 token（cookie + header），常量时间比较；Origin 与请求来源一致时放行
- **限流** — 计数存放在 D1（KV 最终一致会被并发绕过）：登录 5 次失败锁定 15 分钟、订阅每 IP 每分钟 120 次、刷新 30 次/分、批量改节点 60 次/分、改密 10 次/10 分钟
- **审计日志** — 所有管理操作记录到 audit_logs（写入走 `waitUntil`，不阻塞响应）

## 项目结构

```
src/
├── shared/
│   └── types.ts              # 共享类型定义
├── worker/
│   ├── index.ts              # Worker 入口 (fetch + scheduled)
│   ├── app.ts                # 组装：中间件 + 顺序挂载路由 + 错误处理
│   ├── http.ts               # 请求辅助 (body / 分页 / slug / 脱敏)
│   ├── validation.ts         # 集中的 Zod 请求体 schema
│   ├── routes/               # 按资源拆分的路由模块
│   │   ├── public.ts         #   健康检查 / 初始化 / 登录 / 订阅下载 (免鉴权)
│   │   ├── account.ts        #   会话 / 登出 / 改密
│   │   ├── sources.ts        #   数据源 CRUD / 刷新 / 日志
│   │   ├── nodes.ts          #   节点查询 / 更新 / 批量
│   │   ├── subscriptions.ts  #   订阅 CRUD / 预览 / 令牌 / 缓存
│   │   └── system.ts         #   概览 / 设置 / 审计日志
│   ├── env.ts                # 环境变量绑定
│   ├── adapters/
│   │   ├── input/            # 输入解析器
│   │   │   ├── index.ts      #   格式自动探测
│   │   │   ├── uri-list.parser.ts  # ss/vmess/vless/trojan/hy2/tuic/anytls URI
│   │   │   ├── clash.parser.ts     # Clash YAML
│   │   │   ├── internal-json.parser.ts
│   │   │   └── shared.ts     #   base64 / fingerprint / port
│   │   └── output/
│   │       └── index.ts      # Mihomo / Sing-box / Raw / JSON 渲染
│   ├── services/
│   │   ├── sources.ts        # 数据源刷新逻辑（租约 / 并发 / 失败退避）
│   │   ├── subscriptions.ts  # 订阅生成 + 令牌 + KV 缓存
│   │   ├── auth.ts           # 会话 / CSRF / 登录限流
│   │   ├── rate-limit.ts     # D1 计数限流
│   │   └── audit.ts          # 审计日志
│   ├── security/
│   │   ├── crypto.ts         # AES-GCM / HMAC / SHA-256
│   │   ├── password.ts       # PBKDF2
│   │   ├── regex.ts          # 线性时间正则引擎 (Thompson NFA + Pike VM)
│   │   └── safe-fetch.ts     # SSRF 防护 + DNS 预解析
│   └── db/
│       └── schema.ts         # Drizzle schema
├── dashboard/
│   ├── App.tsx               # 管理 SPA
│   ├── api.ts                # API 客户端（GET 短缓存 + 超时）
│   ├── hooks.ts              # useAsync / usePagedList / useBusy
│   ├── components.tsx        # 通用组件
│   ├── pattern-check.ts      # 过滤规则的轻量前端校验
│   ├── clipboard.ts
│   ├── main.tsx
│   └── styles.css
migrations/
├── 0001_initial.sql              # 初始表结构
├── 0002_performance_indexes.sql
├── 0003_source_kind.sql
├── 0004_refresh_safety.sql       # 刷新租约 + nodes_staging
└── 0005_performance_ratelimit.sql # 索引 / failure_count / rate_limits
```

## 开发

```bash
npm run dev        # 本地开发 (Wrangler dev)
npm run build      # 构建前端
npm run lint       # ESLint
npm run typecheck  # TypeScript 类型检查
npm test           # Vitest 单元 + 集成测试
```
## TODO

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)；本次 `0.2.0` 优化升级的详细说明见 [docs/upgrade-notes.md](./docs/upgrade-notes.md)。

## License

MIT
