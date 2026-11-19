# WorkBuddy 网关 Docker 封装

基于当前项目的零依赖 Node 网关，包含国际站会话头兼容补丁和远程控制台开关。
只封装网关；不需要官方桌面客户端常驻，不修改正在运行的裸 Node 服务。

## 快速启动

在本目录运行：

```bash
cp .env.example .env
chmod 600 .env
docker compose up -d --build
```

示例默认 `HOST_PORT=9000`，避免与已有 `127.0.0.1:8788` 服务冲突。
首次启动会在命名卷生成配置和随机主 API Key，控制台默认关闭。
只需要模型 API 时保持关闭；要打开管理页面，将 `.env` 中
`ALLOW_REMOTE_CONSOLE=true` 后重新创建容器：

```bash
docker compose up -d
```

浏览器访问 `http://127.0.0.1:9000/console`，用户名 `admin`，密码是网关主 API Key，
不是 CodeBuddy 账号密码。查看初次生成的 Key（只在自己的终端查看，不要发到聊天）：

```bash
docker compose exec -T gateway node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/data/config.json','utf8'));console.log(Array.isArray(c.apiKey)?c.apiKey[0]:c.apiKey)"
```

空卷没有任何登录态。请在控制台的账号登录页用自己的浏览器完成设备授权，
或导入已转换的网关 `auth.<site>.json` / `auth.<site>.pool.json`。
没有有效授权时，健康检查仍可通过，但不能据此宣称模型推理可用。

## 从 GitHub Actions 镜像启动（不用本机编译）

Fork：[wttwins/hermes-workbuddy-integration](https://github.com/wttwins/hermes-workbuddy-integration)。
保留原作者 MIT 许可证和上游关系；这里只维护已测试的网关补丁与 Docker 封装。

复制 `.env.example` 为 `.env`，将镜像设置为：

```dotenv
IMAGE=ghcr.io/wttwins/hermes-workbuddy-integration:latest
HOST_PORT=9000
```

然后执行：

```bash
docker compose pull gateway
docker compose up -d --no-build
```

`latest` 跟随本 Fork 的 `main`；每次发布同时保留 `sha-<完整提交SHA>` 源码版本标签。
需要锁定完全相同的镜像内容时使用 `@sha256:<镜像digest>`；同一提交重新构建也可能因基础镜像更新而改变内容。
推送 `vX.Y.Z`（或 `vX.Y.Z-预发布名`）tag 会发布对应版本标签，不自动发布 Release 或部署服务器。
若 GHCR package 仍是私有，拉取需要有 `read:packages` 权限的认证；公开仓库并不自动保证新 package 公开。
在 Package settings 中改成 Public 后才支持匿名拉取；公开后不能再改回私有。

`.github/workflows/ci.yml` 先运行 Node 回归和零依赖检查，再在 AMD64 / ARM64 原生 runner
分别构建并验收容器；全部通过后，才用仓库自己的 `GITHUB_TOKEN` 发布双架构镜像。
PR 只验证，不发布；不会上传账号授权、访问生产数据或自动连接服务器部署。
上游更新需要审查后合并，Fork 不自动同步覆盖本 Fork 的补丁。

## 端口与环境变量

- `PORT`：容器内应用端口，默认 8788。支持 `docker run -e PORT=9000`。
- `IMAGE`：Compose 镜像名，默认本地构建镜像；可指定 GHCR `latest`、版本或提交 SHA 标签。
- `HOST_PORT`：Compose 发布到宿主的端口，与应用端口独立。
- `BIND_ADDRESS`：宿主发布地址，默认 `127.0.0.1`。只在可信局域网场景主动设 `0.0.0.0`；公网建议通过 HTTPS 反代。
- `HOST`：容器内监听地址，镜像默认 `0.0.0.0`。不要改成容器回环地址后又期待宿主映射能访问。
- `WB_CONFIG_DIR`：数据目录，镜像默认 `/data`。
- `ALLOW_REMOTE_CONSOLE`：只接受 `true` / `false`，默认关闭。Docker NAT 下宿主连接属于容器的远程连接，使用控制台必须显式开启；开启仍需主 Key 认证。
- `API_KEY`：可选主 Key。空值保留原 Key，首次启动自动生成随机 Key。
- `API_KEY_FILE`：可选的容器内密钥文件路径，支持只读挂载的 secret 文件。不能同时提供非空 `API_KEY`。
- `DATA_DIR`：Compose 数据来源，默认命名卷 `workbuddy-data`；也可填绝对路径作 bind mount。

例：容器内 9000、宿主 19000：

```dotenv
PORT=9000
HOST_PORT=19000
```

Compose 会映射 `127.0.0.1:19000:9000`。修改 Compose 环境变量或端口映射要重建容器，
单纯 `docker compose restart` 不会应用新的容器环境和映射。

环境变量优先于数据卷配置。Docker 启动器只把明确设置的字段写入数据卷的配置，
不改账号凭据、站点、模型、上游地址及其他已有值。
`PORT` 严格接受 1–65535 的整数；容器不接受随机端口 0，也不会把 `9000abc` 悄悄转成 9000。
控制台中的开关立即保存；如果 Compose 仍指定该环境变量，下次重建/启动以环境变量为准。

## 不使用 Compose

```bash
docker build -t workbuddy-openai-proxy:local .
docker volume create workbuddy-data
docker run -d --name workbuddy-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:19000:9000 \
  -e PORT=9000 \
  -e ALLOW_REMOTE_CONSOLE=true \
  -v workbuddy-data:/data \
  workbuddy-openai-proxy:local
```

镜像已设置 `STOPSIGNAL SIGINT`，会在正常停止时落盘用量和账号池。
容器以 UID 1000 运行，镜像没有打入配置、账号 token、日志、备份或宿主环境文件。

## 数据持久化、导入与迁移

`/data` 整目录保存 `config.json`、全部 `auth*.json`、用量及其他运行数据。
不要只挂旧单账号文件：账号池存在时优先使用，续期和设备登录也需要写新文件。
不要挂整个 `server` 目录覆盖镜像代码。

使用绑定目录时，由自己准备独立目录并保证 UID 1000 可读写；例如：

```bash
mkdir -p /path/to/workbuddy-data
sudo chown 1000:1000 /path/to/workbuddy-data
sudo chmod 700 /path/to/workbuddy-data
```

然后把 `.env` 的 `DATA_DIR` 改为该绝对路径。
**不要对正在运行的原服务数据目录直接 chown，也不要让旧 Node 与 Docker 共用写目录。**
迁移已有授权时，先停止旧实例，再复制最终完整数据到新目录并设置新目录权限。
本封装过程不会自动迁移、停止或替换本机/10.54 的现有服务。

## 检查与备份

```bash
docker compose ps
docker compose logs --tail=100 gateway
curl http://127.0.0.1:9000/health
```

健康检查会随实际 `PORT` 变化，只做本地状态读取，不消耗模型额度。
数据卷是独立的，容器重建不会删除；不要运行 `docker compose down -v`，除非明确要删除数据。
授权备份含敏感 token，请私密存储。

## 构建与验证范围

Dockerfile 可使用官方 Node 多架构基础镜像构建；本机实际构建的平台以交付验证记录为准，
不把 ARM64 成功当成 AMD64 已实测。GitHub Actions 的实际运行结果与 GHCR digest 才是发布证据。
自动验证使用独立临时数据和夹具 Key，不导入生产登录态、不调用收费模型。
