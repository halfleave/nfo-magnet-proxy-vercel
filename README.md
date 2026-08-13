# NFO 磁力搜索代理（Vercel 部署版）

Deno Deploy 当前暂停新用户注册，改用 Vercel 免费层部署。Vercel 出口 IP 干净，直连 bt4g 稳定。

## 目录结构
```
vercel-magnet-proxy/
├── api/
│   └── index.js      # Vercel Edge Function 入口（直连 bt4g 优先 + 代理兜底）
├── vercel.json       # 把根路径 / rewrite 到 /api/index.js
├── package.json      # type: module
└── README.md
```

## 部署步骤
1. 把 `vercel-magnet-proxy/` 这个目录推到一个 GitHub 仓库（新建一个即可，例如 `nfo-magnet-proxy-vercel`）。
2. 打开 https://vercel.com/ ，用 GitHub 账号登录。
3. Add New → Project → Import 刚才的仓库。
4. Framework Preset 选「Other」，其余默认 → Deploy。
5. 部署完得到形如 `https://xxx.vercel.app` 的地址（自带 HTTPS）。

## App 里配置
iPhone 上 NFO 编辑器 → 设置页标题连点 3 次进入里模式 → 设置 → 磁力搜索配置 →
把地址填成 `https://xxx.vercel.app`（即根地址，vercel.json 已把它转到函数）。
重新搜一次即可。

## 本地预览（可选）
装好 Vercel CLI 后：`vercel dev`，访问 http://localhost:3000/?q=inception&source=bt4g 测试。
