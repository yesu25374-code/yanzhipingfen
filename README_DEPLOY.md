# GitHub Pages 部署说明

这个仓库是静态网页，GitHub Pages 不能直接运行百度人脸识别代理。

## 需要上传的文件

- `index.html`
- `avatar.png`：头像图片，必须和 `index.html` 同级

## 百度 AI 数据库代理

线上版必须使用 Cloudflare Worker / Vercel / Render 之类的后端代理。
本仓库提供了 `cloudflare-worker.js`。

部署 Cloudflare Worker 后，在 Worker 环境变量里添加：

```txt
BAIDU_API_KEY=你的百度 API Key
BAIDU_SECRET_KEY=你的百度 Secret Key
```

然后把 `index.html` 里的：

```js
AI_URL='/api/baidu-face'
```

改成你的 Worker 地址，例如：

```js
AI_URL='https://your-worker-name.your-account.workers.dev'
```
