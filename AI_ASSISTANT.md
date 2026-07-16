# AI 助手接入说明

本项目的右下角 AI 助手已接入后端代理 `/api/assistant`。前端不会保存或暴露模型密钥，密钥只从服务器环境变量或本地 `.env` 读取。

## 本地启动

```bash
copy .env.example .env
npm run preview
```

启动后打开 `http://127.0.0.1:8212/`。

## 必需环境变量

- `ANTHROPIC_BASE_URL`：Kimi/Anthropic 兼容 API 地址，例如 `https://api.kimi.com/coding/`
- `ANTHROPIC_AUTH_TOKEN`：服务端使用的 API token
- `ANTHROPIC_MODEL`：默认 `kimi-for-coding`

## 工作方式

1. 前端把用户问题发给 `/api/assistant`。
2. 后端从 `activities.json`、`project-wall.json`、`exhibitors.json`、`side-events.json` 检索相关资料。
3. 后端把压缩后的上下文交给模型回答。
4. 如果后端未配置或模型异常，前端会回退到内置固定问答。
