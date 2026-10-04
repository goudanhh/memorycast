# MemoryCast — Oracle + Docker 单用户版

当前版本已经关闭登录功能。

打开网站后会直接进入 MemoryCast，所有访问者共用同一份 PostgreSQL 数据，因此它目前适合你自己使用。

## 功能

- 无需登录
- PostgreSQL 云端数据
- 电脑 / 手机 / 手表同步同一份数据
- FSRS 间隔重复
- 中英文 TTS
- AI 整理长笔记
- AI 自动生成选择题 / 填空题 / 简答题 / 听力题
- AI 自动判分
- 错题回炉 FSRS
- 知识库
- 学习统计
- 手表模式
- Docker Compose
- Nginx
- HTTPS 脚本
- PostgreSQL 备份

## 重要说明

因为当前没有登录：

任何能够访问你网站的人，都能看到和修改同一份学习数据。

所以建议：

1. 先用服务器 IP 自己测试。
2. 如果以后公开域名给别人访问，再增加密码或登录保护。

## 1. Oracle 服务器开放端口

需要 TCP：

- 22 SSH
- 80 HTTP
- 443 HTTPS

如果 Ubuntu 启用了 UFW：

    sudo ufw allow OpenSSH
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp

## 2. 安装 Docker

    sudo apt update
    sudo apt install -y ca-certificates curl git openssl
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER

退出 SSH 后重新登录。

检查：

    docker --version
    docker compose version

## 3. 获取项目

    git clone https://github.com/goudanhh/memorycast.git
    cd memorycast

如果已经 clone 过：

    cd memorycast
    git pull

## 4. 配置 .env

    cp .env.example .env
    nano .env

最重要的是：

    POSTGRES_DB=memorycast
    POSTGRES_USER=memorycast
    POSTGRES_PASSWORD=你的随机强密码

OpenAI 是可选的：

    OPENAI_API_KEY=
    OPENAI_MODEL=gpt-5.4-mini

FSRS：

    FSRS_RETENTION=0.90

生成数据库随机密码：

    openssl rand -hex 24

如果暂时不填写 OPENAI_API_KEY：

- 卡片
- PostgreSQL
- FSRS
- TTS
- 知识库

仍然可以正常使用。

AI 整理和 AI 测试暂不可用。

## 5. 启动

    bash scripts/deploy.sh

或者：

    docker compose up -d --build

检查：

    docker compose ps

应该看到：

    db
    api
    web
    gateway

都处于运行状态。

## 6. 访问

浏览器：

    http://你的服务器公网IP

目前不需要 GitHub OAuth App，不需要：

- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- Authorization callback URL

## 7. 数据保存位置

真实数据存放在 PostgreSQL Docker Volume：

    postgres_data

不会因为普通的：

    docker compose down

而消失。

不要执行：

    docker compose down -v

除非你确定要删除数据库数据。

## 8. FSRS

手动评分：

- Again = 忘了
- Hard = 模糊
- Good = 记住
- Easy = 很熟

AI 测试：

- wrong → Again
- partial → Hard
- correct → Good

## 9. 数据库备份

    bash scripts/backup.sh

备份输出：

    backups/memorycast_YYYYMMDD_HHMMSS.sql.gz

## 10. HTTPS

有域名后：

    bash scripts/enable-https.sh your-domain.com your@email.com

## 11. 更新网站

服务器进入项目：

    cd memorycast
    git pull
    docker compose build api
    docker compose up -d

## 你现在应该做什么

如果你服务器已经 clone 过旧版本，直接：

    cd memorycast
    git pull

然后检查 .env，把以前的 GitHub OAuth 内容删掉也可以，不删也不会再使用。

最后：

    docker compose up -d --build

然后打开：

    http://你的服务器公网IP
