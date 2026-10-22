# unvideo

视频解析站（rou.video 无广告播放 + 51吃瓜资讯视频）—— 由原 `rou-proxy-player.py`
单文件脚本重构为 **React + TypeScript + Vite（前端）/ Convex（后端）** 的应用。

- 前端是纯静态 SPA，部署在 **GitHub Pages**：https://l0v3lac3.github.io/unvideo/
- 后端跑在 **Convex**（HTTP actions），承担所有需要服务端能力的工作

## 为什么必须有服务端

原脚本的代理逻辑不是可有可无的，以下三点都是实测结论（不是推测）：

1. **上游要求浏览器 UA**：rou.video 与其视频 CDN 对无 UA / 非浏览器 UA 的请求返回 403。
   浏览器无法为媒体请求伪造 `User-Agent`，所以必须服务端发请求。
2. **载荷被 PNG 包裹**：所有媒体响应都是 PNG 容器，真实数据藏在自定义块
   `roUd`（`0x726f5564`）里，可能还经过 zlib 压缩。不解包得到的字节既不能播放，
   也无法被 hls.js 解析。
3. **完全没有 CORS 头**：浏览器无法直接 `fetch` 这些响应。

**不需要** TLS/JA3/JA4 指纹伪装（curl_cffi、impers、cycletls 之类）：Cloudflare 在这几个
端点上接受普通 `fetch`，实测多种 UA 均可通过。因此本项目不引入任何指纹伪装依赖。

## 技术栈

| 层 | 技术 | 版本 |
| --- | --- | --- |
| 前端框架 | React | 19.3 |
| 语言 | TypeScript | 6.0 |
| 构建 / 开发服务器 | Vite | 8.3 |
| 播放器 | hls.js | 1.7（按需动态加载） |
| 后端 | Convex（HTTP actions + V8 isolate） | 1.46 |
| 解压缩 | fflate（纯 JS，替代 Node `zlib`） | 0.8 |
| 检查 / 格式 | oxlint（Vite 模板默认） / Prettier | — |
| 包管理器 | npm | 10.x |

## 目录结构

```
unvideo/
├── convex/                  # 后端（Convex）
│   ├── http.ts              # 全部 HTTP 路由（见下节接口表）
│   ├── rou.ts               # rou.video：PNG 解包、ev 解密、HMAC 签名、播放列表重写、SSRF 防护
│   ├── cg51.ts              # 51吃瓜：节点发现、列表/文章抓取、AES 图片解密
│   ├── schema.ts            # 数据模型（当前为空）
│   └── _generated/          # Convex 自动生成（勿手改）
├── src/
│   ├── App.tsx              # 页面外壳：双 tab（rou.video / 51吃瓜）、hash 路由驱动
│   ├── main.tsx             # 入口
│   ├── components/Player.tsx  # HLS 播放器（hls.js 挂载、错误恢复、原生 HLS 回退）
│   ├── components/Feed.tsx  # 51吃瓜列表 + 上下双组分页
│   ├── components/Article.tsx # 51吃瓜文章页（图集 + 内嵌播放）
│   ├── lib/router.ts        # 手写 hash 路由（前进/后退/滚动恢复/深链）
│   ├── lib/api.ts           # 后端 API 客户端
│   └── index.css            # 样式
├── public/favicon.svg
├── .github/workflows/deploy.yml  # GitHub Pages 部署
├── .env.example             # 环境变量清单
└── index.html
```

## 后端接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/resolve?url=<视频页>` | 抓取页面 → 正则提取 `ev:{d,k}` → base64 + 逐字节减 k → JSON → 返回 `videoUrl`、**已签名的** `playlistUrl`、`thumbVttUrl`。仅允许 rou.video 域。 |
| `GET /api/media?u=<b64url>&s=<hmac>` | 抓取目标 → PNG 解包 → 是播放列表则把其中所有 URI 重写为带签名的本接口地址后返回；是分片则直接回传。 |
| `GET /api/node` | 发现 51吃瓜当前内容节点（主站反爬严格，节点发现必须服务端做）+ 分类导航。 |
| `GET /api/feed?path=&page=` | 抓取 51吃瓜指定分类/归档页的列表，封面图转签名 URL。 |
| `GET /api/article?path=/archives/<id>/` | 文章元数据 + 图集 + 内嵌视频（均转签名 URL）。 |
| `GET /api/img?u=<b64url>&s=<hmac>` | 抓取并 AES 解密的图片字节流（签名方案同 `/api/media`）。 |
| `GET /api/health` | 存活探测。 |
| `GET /api/selftest` | 运行时能力自检（fflate / Web Crypto / 密钥是否配置），不回显密钥。 |

设计要点：

- **签名防滥用**：`/api/media` 的 URL 经 HMAC-SHA256 签名（密钥为 Convex 环境变量
  `ROU_PROXY_SECRET`），因此本部署不会变成公开代理。未配置密钥时退化为域名白名单。
- **绝对地址**：重写出的分片地址使用后端自身 origin（取 `req.url`）。因为前端在
  GitHub Pages、后端在 Convex，**绝对不能用根相对路径**——否则浏览器会把
  `/api/media` 解析到页面所在域。
- **SSRF 防护**：仅允许 https，拒绝 localhost / 私有网段 / link-local（如云元数据地址）。
- 播放列表重写同时覆盖裸 URI 行与 `URI="..."` 属性（`EXT-X-KEY`、`EXT-X-MAP`、
  `EXT-X-MEDIA`、`EXT-X-I-FRAME-STREAM-INF` 等）。
- 分片响应带 `Cache-Control: immutable`，避免同一分片反复穿过部署。

## 本地开发

```bash
npm install
npx convex dev          # 终端 1：后端，热同步 convex/ 到 dev 部署
npm run dev             # 终端 2：前端（默认 http://localhost:5173）
```

`npx convex dev` 首次运行会要求浏览器 OAuth 登录并创建 dev 部署，随后把
`VITE_CONVEX_URL`、`VITE_CONVEX_SITE_URL`、`CONVEX_DEPLOYMENT` 写进 `.env.local`。
注意 1.46.x 的 dev 部署跑在**云端**，本机没有 3847 端口进程。

首次部署后端后需要配置签名密钥（值不要提交到仓库）：

```bash
npx convex env set ROU_PROXY_SECRET "$(openssl rand -hex 32)"
```

## 检查与构建

```bash
npm run lint           # oxlint
npm run format         # Prettier 格式化
npm run format:check   # 只检查格式
npm run build          # tsc -b && vite build（产物在 dist/）
```

分工：TypeScript 管类型，oxlint 管规范与潜在错误，Prettier 只管格式。

## 环境变量

`.env.local`（本地，已被 gitignore）：

| 变量 | 说明 |
| --- | --- |
| `VITE_CONVEX_SITE_URL` | HTTP actions 地址 `https://<deployment>.convex.site`，前端调用后端用的就是它 |
| `VITE_CONVEX_URL` | 客户端地址 `https://<deployment>.convex.cloud`（当前未使用，留给将来的 query/mutation） |
| `CONVEX_DEPLOYMENT` | CLI 用来定位部署，由 `npx convex dev` 写入 |

Convex 环境变量（服务端，不在仓库里）：`ROU_PROXY_SECRET`。

## 部署

前端（GitHub Pages）由 `.github/workflows/deploy.yml` 完成：
`npm ci → 校验变量 → lint → build → 校验产物内含 convex.site → 上传 → 发布`。

仓库变量（Settings → Secrets and variables → **Actions** → Variables）：

| 变量 | 必需 | 值 |
| --- | --- | --- |
| `CONVEX_SITE_URL` | 是 | `https://<deployment>.convex.site` |
| `CONVEX_URL` | 否 | `https://<deployment>.convex.cloud`（仅供将来的客户端 SDK 使用） |

注意：后端地址在**构建时**固化进产物，更换 Convex 部署后需重新触发构建。

后端发布到生产需显式执行 `npx convex deploy --prod`（当前只有 dev 部署，前端指向它）。

## 与原脚本的对应关系

| 原 Python | 现在 |
| --- | --- |
| `unwrap_png()` / `decrypt_ev()` | `convex/rou.ts`（同样的 `roUd` 块、同样的 zlib 与逐字节减 k 算法） |
| `/api/resolve` | `convex/http.ts` 的 `/api/resolve`（额外做了域名白名单与签名） |
| `/proxy/<url>` | `/api/media?u=&s=`（额外做了签名、SSRF 防护、绝对地址、缓存头） |
| 内嵌 `PLAYER_HTML` 字符串 | `src/components/Player.tsx` + `src/App.tsx`（React 组件） |
| 本地 `hls.js` 文件 / CDN 拉取 | npm 依赖 `hls.js`，按需动态加载 |
| 硬编码的 Cookie 常量 | 已删除——实测上游并不需要 Cookie，只需 UA |

## 已知限制

- **带宽**：媒体字节会穿过 Convex。HTTP action 响应上限 100 MiB（远大于分片），
  但免费档并发 HTTP action 为 64，且需留意用量配额。
- **播放列表无 `#EXT-X-ENDLIST`**：hls.js 会按点播处理（实测缓冲正常），
  但上游格式若有变化需重新验证。
- 未创建生产部署；未接入数据库功能（`schema.ts` 为空）。
