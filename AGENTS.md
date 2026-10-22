# AGENTS.md — unvideo 项目规范

本文件是本项目对 AI 编码助手（Hermes / Claude Code / Codex 等）的项目上下文。
只放**属于这个项目**的内容：架构、命令、约定、部署。个人语气/风格不放这里
（那属于 Hermes 的 SOUL.md）。

## 项目概览

unvideo：视频解析站，多站点架构。每个上游站点 = 一个后端适配器
（`convex/sources/<site>.ts`，实现 `Source` 接口）+ 前端注册表
（`src/lib/sources.ts`）一行；通用代码（`http.ts` 分发器、前端视图、路由）
不认识具体站点，扩展新站点不碰它们。

- **前端**：React 19 + TypeScript + Vite。静态构建，部署在 **GitHub Pages**
  （纯静态托管，无 SPA 回退）。线上：`https://l0v3lac3.github.io/unvideo/`
- **后端**：Convex HTTP actions（`convex/`）。前端只通过 HTTP 调自己的
  `/api/*`（`VITE_CONVEX_SITE_URL`，`.convex.site` 域），当前**没有**
  `ConvexReactClient`；若将来引入 query/mutation 才需要它，且要用
  `VITE_CONVEX_URL`（`.convex.cloud` 域）。**两个域不同，不要混用。**
- **为什么抓取在服务端**：上游站点要求浏览器 UA、响应可能被 PNG 包裹、不返回
  CORS 头，因此抓取与解包必须在 Convex 端完成（`convex/`）。

## 常用命令

```bash
npm run dev            # Vite 开发服务器（读取 .env.local）
npm run build          # tsc -b + vite build（dist/，base: './'）
npm run preview        # 本地预览生产构建
npm run lint           # oxlint（规范/错误）
npm run format         # prettier --write src
npm run format:check   # prettier --check src
npx convex dev --once  # 推送后端到 dev 部署（.env.local 的 CONVEX_DEPLOYMENT）
npx convex deploy      # 生产部署（需用户明确确认）
curl -sS https://<deployment>.convex.site/api/selftest   # 后端能力自检
```

- 包管理器：npm（勿换 yarn/pnpm）。
- 检查分工：tsc 查类型、oxlint 查规范、Prettier 只管格式。
- CI：push `main` → GitHub Actions 构建并部署 GitHub Pages；需要仓库变量
  `CONVEX_SITE_URL`（Settings > Variables），前端构建时烧入 bundle。

## 环境变量

- `.env.local`（已 gitignore，勿提交）：`VITE_CONVEX_SITE_URL`、
  `VITE_CONVEX_URL`（可选）、`CONVEX_DEPLOYMENT`。
- 后端密钥（`PROXY_SECRET`）只放 **Convex 环境变量**
  （`npx convex env set`），绝不写入源码、日志或提交。

## 架构地图

```
src/
  main.tsx              入口（StrictMode，无 Convex provider）
  App.tsx               页面：站点切换栏、首页卡片、路由消费
  lib/router.ts         hash 路由：parse/build、pushState 封装、滚动记忆
  lib/sources.ts        前端站点注册表（每个站点一行；与后端 sources/index.ts 对应）
  lib/api.ts            前端 API 客户端（只与 /api/* 对话，带 src 参数）
  lib/types.ts          归一化模型（镜像 convex/sources/types.ts，两边同步改）
  components/
    Home.tsx            首页：站点卡片
    Feed.tsx            列表（分页/分类，会话缓存）
    Article.tsx         文章（归一化 body 块、推荐卡片，会话缓存）
    Player.tsx          hls.js / mp4 播放
convex/
  http.ts               薄 HTTP 分发器（/api/health、selftest、site、video、
                        feed、article、media、img；按 src 派发到适配器）
  proxy.ts              共享媒体代理：UA fetch、SSRF 防护、HMAC 签名、
                        播放列表重写、HttpError
  schema.ts             数据模型（当前为空）
  sources/              站点适配器，一个站点一个文件
    types.ts            归一化模型 + Source 接口
    index.ts            站点注册表
    rou.ts              rou.video：抓取、PNG 解包、播放列表重写、签名
    cg51.ts             51吃瓜：节点发现、feed/文章解析、AES 图片解密
  _generated/           自动生成（convex codegen），不可手改
```

## 路由约定（前端）

- 所有视图在 **hash 路由**里，路由带站点前缀：`#/`（首页站点卡片）、
  `#/<src>/`、`#/<src>/page/N/`、`#/<src>/category/<slug>/N/`、
  `#/<src>/archives/<id>/`、`#/<src>?url=<page-url>`（视频源播放器）。
  旧路由（无前缀：`#/archives/<id>/`、`#/category/...`、`#/page/N/`）在
  `router.ts` 里映射到 `cg51`，深链书签不失效。GitHub Pages 是纯静态托管，
  路径路由会在刷新/深链时 404，**不要改成路径路由**（vite `base: './'` 同理，
  勿动）。
- 页码、分类、当前文章、播放 URL 都在路由里，**不要**存组件 state；
  列表用 `key={src:path:page}` 挂载。
- 应用内导航一律走 `lib/router.ts` 的 `navigate()` / `goBack()`（维护
  `history.state.depth`），不要直接 `location.hash = ...` 或裸 `history.back()`。
- 列表/文章数据有会话级缓存（模块级 Map，有上限）：返回即时显示 + 恢复滚动
  位置，同时后台重新验证。
- feed 条目的 `path` 由后端归一化（以 `/` 开头的站内路径），前端直接用它导航；
  不以 `/` 开头的值不是文章路径，不要静默跳转。
- 站点 id 即路由前缀：新增站点时 id 不能与 `page`/`category`/`archives` 等
  路径段冲突（见 `src/lib/sources.ts` 注释）。

## 关键实现约束（改后端前必读）

- **不要引入 TLS 指纹伪装库**（curl_cffi / impers / cycletls 等）：实测上游
  只校验 UA，普通 fetch 即可通过。真遇到指纹拦截先实测再引入。
- **PNG 自定义块类型是 `roUd`（大写 U，0x726F5564）**，写错会静默失败
  （原样返回 PNG 字节）。
- **播放列表重写必须产出绝对地址**：前端（Pages）与后端（Convex）跨域，
  根相对路径会被解析到页面所在域。origin 取自 `req.url`。
- **分片 URL 必须签名**（`PROXY_SECRET`，HMAC-SHA256）并在服务端校验，
  否则部署会变成公开代理。
- **媒体端点保留 SSRF 防护**（仅 https、拒绝私有/环回/link-local）与各源的
  域名白名单（`mediaHosts`/`imageHosts`，定义在适配器里；未配置
  `PROXY_SECRET` 时 `/api/media` 依赖 `mediaHosts` 防止成为公开代理）。
- Convex 运行时是 V8 isolate，**没有 Node 的 zlib**：解压缩用 `fflate`
  （`unzlibSync`）。
- 不要硬编码上游 Cookie：实测不需要。

## 验证与汇报

- 每次改动：`npm run lint && npm run build`；涉及格式跑 `npm run format:check`，
  失败就 `npm run format` 再验证。
- 改动后端除 `/api/selftest` 外建议实测：`/api/video?src=<站点>&url=...` →
  取 `playlistUrl` → 确认分片是**绝对地址**且带签名 → 取一个分片确认是
  MPEG-TS（首字节 0x47）；feed 源则测 `/api/site` → `/api/feed` → `/api/article`。
- 浏览器验证播放时标签页必须可见：**隐藏标签页会节流 hls.js 定时器**
  （播放列表已解析但永不发分片请求）。
- 如实汇报：实际跑过的命令、真实通过/失败结果；未跑的检查不得声称通过。
- **本地构建通过 ≠ 已上线**：前端上线 = push main 触发 Pages 部署；
  后端上线 = `npx convex dev --once` / `npx convex deploy`。汇报时分开说明。

## 添加新站点（扩展模式）

1. 后端：新建 `convex/sources/<site>.ts`，实现 `Source` 接口
   （视频源：`matchUrl`/`resolve`/`transformMedia`；feed 源：`siteInfo`/`feed`/
   `article`/`matchArticle`；按需实现 `imageHosts`/`transformImage`/`fetchTarget`），
   并在 `convex/sources/index.ts` 注册。
2. 前端：在 `src/lib/sources.ts` 加一个条目（`id`/`label`/`desc`/`kind` + 取数
   函数）。`id` 同时是路由前缀和 `src` 参数。
3. 不要改 `http.ts`、`App.tsx`、`router.ts`、`Feed.tsx`、`Article.tsx`、
   `Home.tsx`——它们只认归一化模型。
4. 部署：后端 `npx convex dev --once`；前端 push main（Pages 自动部署）。

## 工作规则

1. **改前检查**：先读相关文件的现状，不要凭记忆或猜测改动。
2. **小步修改**：一次一个关注点，可审查的 diff，不做顺手大重构。
3. **不覆盖用户改动**：用户已有的未提交修改不要丢弃；有冲突先指出并询问。
4. **生产安全**：未经明确确认，不执行 `convex deploy`、不删云端数据、
   不改生产配置（CI 变量、部署设置）。
5. **密钥安全**：敏感信息只进 `.env.local` 或 Convex 环境变量。

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
