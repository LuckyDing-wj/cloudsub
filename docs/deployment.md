# 部署说明

## Deploy to Cloudflare

公开仓库可使用 README 中的按钮部署，但**必须先替换资源 ID**。

`wrangler.jsonc` 里的 `d1_databases[0].database_id` 与 `kv_namespaces[0].id` 是**账号专属**的：直接沿用仓库里的值，部署会以
`D1 binding 'DB' references database '<id>' which was not found (code: 10181)`
或 KV 找不到命名空间而失败。Wrangler 不会自动改写已存在的 ID。

替换步骤：

```bash
npx wrangler d1 create cloudsub          # 复制返回的 database_id
npx wrangler kv namespace create CACHE   # 复制返回的 id
```

把两个值填入 `wrangler.jsonc` 后提交，再点部署按钮（或运行 `npm run deploy`）。

`package.json` 的部署命令为：

```text
npm run build
wrangler d1 migrations apply DB --remote
wrangler deploy
```

迁移命令使用绑定名 `DB`，因此部署者即使修改数据库资源名也不会破坏流程。

## 必需 Secrets

| 名称 | 用途 |
| --- | --- |
| `APP_SECRET` | 为会话和订阅令牌计算 HMAC；轮换后旧令牌会失效 |
| `DATA_ENCRYPTION_KEY` | AES-GCM 加密数据源原文和自定义请求头 |

可选的 `INITIAL_ADMIN_TOKEN` 会要求首次初始化请求提供同一令牌。不要把真实值写入 `.dev.vars.example`、Wrangler vars 或 Git 历史。

## 首次启动

1. 确认 `/api/system/status` 的 `migrationsReady` 与 `secretsConfigured` 为 `true`。
2. 打开 `/setup`，创建至少 12 位的管理员密码。
3. 创建手动测试源并确认节点数。
4. 创建测试订阅，立即保存只显示一次的完整地址。
5. 在目标客户端验证输出格式，再接入正式上游。

## GitHub Actions

`ci.yml` 会对 Pull Request 和主分支运行 lint、类型检查、Workers 测试与生产构建。`deploy.yml` 只支持手动触发（`workflow_dispatch`），需要仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 备份与恢复

CloudSub 0.2 不提供应用内备份界面。生产环境应使用 Cloudflare 的 D1 Time Travel/导出能力，并在密钥管理系统中单独备份 `DATA_ENCRYPTION_KEY`。恢复时先恢复 D1，再绑定同一密钥；更换密钥前必须完成数据重加密迁移。
