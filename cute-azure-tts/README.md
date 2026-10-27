# 萌音工坊 · Azure TTS

独立可部署的中文/英文萌系 TTS 网页，音色选择、情绪风格、语速音调、试听和 MP3 下载。

## 部署（Ubuntu/Docker）

```bash
cp .env.example .env
nano .env  # 填入已有 Azure Speech 服务的 Key 和 Region
chmod 600 .env
docker compose up -d --build
curl http://127.0.0.1:8088/api/health
```

服务仅绑定本机 `127.0.0.1:8088`，可经现有 Nginx 反向代理 + HTTPS 暴露给用户。**不建议直接公开开放**：如公网使用，应通过已有站点登录鉴权和限流防止滥用 Azure 额度。

### Nginx（示意）

```nginx
location /cute-tts/ {
  proxy_pass http://127.0.0.1:8088/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 64k;
}
```

如果在子路径中部署，前端 API 路径使用绝对 `/api/speak`，应额外代理 `/api/` 到 `127.0.0.1:8088/api/`，或直接部署独立子域名（推荐）。

无需把 Azure Key 写进前端、GitHub 或聊天。音色受所在地区和 Azure 账号服务支持范围约束。测试未配置 Key 的环境仅验证基本接口，不能实际合成音频。`XiaoyouMultilingualNeural` 的 cute 等风格受具体区域支持情况影响。