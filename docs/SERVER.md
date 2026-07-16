# Entail 服务端部署与安全模型

## 运行

开发时分别启动 API 与 Vite：

```bash
npm run dev:server
npm run dev
```

生产构建会由同一个 Node 进程提供静态页面和 `/api`：

```bash
npm run build
npm start
```

默认监听 `8787`。数据目录默认为 `server-data/`，生产环境应通过
`PAPER_GRAPH_DATA` 指向持久卷并限制为服务进程可读写。也可运行
`docker compose up --build`。

直接运行和容器默认监听 `0.0.0.0`；仓库附带的 systemd 服务会设置
`HOST=127.0.0.1`，仅允许 Nginx 从本机反向代理访问 API。

首个注册账号会成为管理员。公开部署建议在首次启动前设置 `ADMIN_EMAIL` 与
`ADMIN_PASSWORD` 自动创建管理员，并在需要封闭注册时设置 `ALLOW_REGISTRATION=0`。

## 数据与加密

- 每个用户都有独立的 `users/<user-id>/` 工作区。
- 密码使用独立盐的 `scrypt` 摘要验证，不保存密码。
- 注册时生成随机 256 位工作区密钥；该密钥再用密码经 `scrypt` 派生的密钥封装。
- 项目、云端服务商/API Key、任务输入与结果统一写入用户的 AES-256-GCM 加密仓。
- AI 对话状态和工作区附件也会同步进该加密仓；云端模型的文件/PDF 工具直接在服务端读取与解析。
- 服务端只在有效登录会话内持有已解锁的工作区密钥。网页关闭不会结束会话或任务；
  服务重启后需要用户重新登录解锁。
- 管理员面板只展示账号元数据，不能读取用户的加密工作区内容。

生产环境必须通过 HTTPS 暴露服务。会话 Cookie 为 HttpOnly、SameSite=Strict，
在 `NODE_ENV=production` 时同时启用 Secure。

## 同步语义

浏览器 IndexedDB 始终是可离线使用的本地副本。登录后：

1. 本地项目和删除墓碑上传到 `/api/sync`；
2. 同一项目取 `updatedAt` 较新的版本；
3. 合并结果回写 IndexedDB，但退出登录时不清除本地副本；
4. 新建或修改后的项目先标记为“仅本地/待同步”，同步成功后标记“云端”。

该策略使用客户端时间戳，部署时应确保客户端和服务器时钟基本准确。

## AI 运行位置

模型服务商可选择：

- **本地**：请求仍由浏览器发送，API Key 只留在浏览器会话；
- **云端**：API Key 加密写入用户工作区，服务端创建持久任务，网页关闭后继续执行；
- **Codex Cloud**：使用服务器唯一 Codex 实例和全局串行队列，只允许云端运行。

Codex Cloud 在每次任务的临时工作区内使用 `workspace-write` 沙箱，允许创建和修改
任务所需的中间文件；写入范围不会越过该临时工作区，任务结束后快照会被清理。

云端 OpenAI-compatible、Anthropic 与 Gemini 模型均可调用服务端图谱搜索、节点读取、
项目摘要、工作区文件读取和 PDF 解析工具。登录状态下 TeX 结构抽取也优先在服务端执行，
服务不可用时自动回退本地解析。

主机若提供 `codex` CLI，可保持 `CODEX_ENABLED=1`；标准 Docker 镜像默认关闭，
需要在自定义镜像内安装并认证 Codex 后再启用。

## 当前生产服务器

仓库中的 `deploy/` 包含 `graph.akusm.com` 使用的 systemd、Nginx 与 Git
`post-receive` 配置。推送 `origin/main` 时会运行测试和构建，随后更新
`/opt/paper-graph`、重启 `paper-graph.service` 并重新加载 Nginx。
