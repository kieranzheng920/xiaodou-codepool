# 小豆邀请码 · 公共码池

有码投一个，没码领一个。一人一码，领走即下架，3 天自动过期。

- 领码：原子领取，同一个码不会发给两个人；不会领到自己投的码；每人每天最多 3 个
- 投码：支持一次投多个（空格/换行分隔），6 位字母数字校验，自动去重；每人每小时最多 10 个
- 反馈：领到后可点「能用 / 已被用」，2 人反馈已用的码自动下架
- 最近动态：打码显示（如 WS**B1），30 秒自动刷新
- 隐私：只存 IP 的加盐哈希，不存原始 IP

技术栈：Cloudflare Workers + D1（免费额度足够），单文件 `src/worker.js`。

## 部署（约 5 分钟）

```bash
npm install
npx wrangler login
npx wrangler d1 create xiaodou-codepool   # 把输出的 database_id 填进 wrangler.toml
npm run db:init
npx wrangler secret put SALT              # 随便输一串字符，用来给 IP 加盐
npm run deploy
```

部署后得到 `https://xiaodou-codepool.<你的子域>.workers.dev`。
国内访问 workers.dev 不稳定，建议在 Cloudflare 里绑定一个自己的域名（Workers → 设置 → 域和路由）。
