# 国内 API 代理

`tencent-cloud-function.js` 是腾讯云函数可用的代理入口，返回格式和当前 Cloudflare Worker 一致。

环境变量：

- `BAIDU_API_KEY`
- `BAIDU_SECRET_KEY`

本目录已包含 `serverless.yml`。部署时先在终端设置环境变量：

```powershell
$env:BAIDU_API_KEY="你的百度 API Key"
$env:BAIDU_SECRET_KEY="你的百度 Secret Key"
```

然后运行：

```powershell
npx serverless-cloud-framework deploy
```

部署后拿到公网 URL，例如：

```text
https://example.tencentcloudapi.com/face
```

网站可以这样切换：

```text
https://yesu25374-code.github.io/yanzhipingfen/?api=https%3A%2F%2Fexample.tencentcloudapi.com%2Fface
```

第一次成功后，浏览器会把这个 API 地址记到 `localStorage`，之后不用再带 `api` 参数。
