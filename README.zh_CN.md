# Proxy Worker

[English](./README.md) | [简体中文](./README.zh_CN.md)

Cloudflare Workers 代理服务，提供 GitHub 文件代理和 Docker registry 镜像代理。

## 访问地址

| 线路            | 地址                            |
|---------------|-------------------------------|
| 国际 Cloudflare | <https://proxy.starudream.cn> |
| 国内腾讯云 EO      | <https://proxy.52xckl.cn>     |

下文示例默认使用 `https://proxy.starudream.cn`，国内网络可将域名替换为 `https://proxy.52xckl.cn`。

## GitHub 代理

GitHub 代理用于下载允许列表中的 GitHub release、archive 和 raw 文件。

### 完整 URL

将 GitHub URL 放到代理地址后面：

```bash
curl -L https://proxy.starudream.cn/github/https://github.com/k3s-io/k3s/releases/download/v1.33.1%2Bk3s1/k3s
```

也可以省略 `/github/` 前缀：

```bash
curl -L https://proxy.starudream.cn/https://github.com/k3s-io/k3s/releases/download/v1.33.1%2Bk3s1/k3s
```

### 短路径

支持 `owner/repo/releases/...`、`owner/repo/archive/...`、`owner/repo/raw/...` 形式：

```bash
curl -L https://proxy.starudream.cn/k3s-io/k3s/raw/refs/tags/v1.33.1%2Bk3s1/install.sh
```

```bash
curl -L https://proxy.starudream.cn/fatedier/frp/releases/download/v0.62.1/frp_0.62.1_linux_amd64.tar.gz
```

当前 GitHub 允许列表在 [`src/settings.json`](./src/settings.json) 中维护。

## Docker 代理

Docker 代理可作为 registry mirror 使用。镜像路径写在代理域名后面：

```bash
docker pull proxy.starudream.cn/docker.io/library/hello-world:latest
```

国内线路：

```bash
docker pull proxy.52xckl.cn/docker.io/library/hello-world:latest
```

### Docker Hub 默认规则

`docker.io` 是默认 registry，`library` 是默认 namespace。因此下面三种写法等价：

```bash
docker pull proxy.starudream.cn/docker.io/library/hello-world:latest
docker pull proxy.starudream.cn/library/hello-world:latest
docker pull proxy.starudream.cn/hello-world:latest
```

都会代理到：

```text
docker.io/library/hello-world:latest
```

### 其他 registry

显式把 registry 写在镜像路径前面：

```bash
docker pull proxy.starudream.cn/ghcr.io/home-assistant/home-assistant:latest
docker pull proxy.starudream.cn/registry.k8s.io/pause:3.10
docker pull proxy.starudream.cn/mcr.microsoft.com/dotnet/runtime:9.0
docker pull proxy.starudream.cn/quay.io/prometheus/prometheus:latest
```

当前支持的 registry：

| Registry            | 是否需要白名单 |
|---------------------|---------|
| `docker.io`         | 是       |
| `gcr.io`            | 是       |
| `ghcr.io`           | 是       |
| `quay.io`           | 是       |
| `registry.k8s.io`   | 否       |
| `mcr.microsoft.com` | 否       |
| `docker.elastic.co` | 否       |

需要白名单的 registry 只允许 [`src/settings.json`](./src/settings.json) 中配置的镜像仓库。

### 上游优先级

镜像拉取请求通过白名单检查后会优先使用 SparkCR；SparkCR 不可用或返回非成功响应时，自动回退到配置的源 registry。

SparkCR 的 manifest 和未缓存 blob 会通过 Worker 流式返回；已缓存 blob 的重定向会直接返回给 Docker，因此 blob 数据不经过 Worker。响应开始流式传输后发生的错误无法再回退到源 registry。

## 配置

主要配置集中在 [`src/settings.json`](./src/settings.json)：

- `github.owners`: 允许代理的 GitHub owner。
- `github.repositories`: 允许代理的 GitHub 仓库。
- `docker.accelerator`: Docker 优先加速服务的地址、鉴权和超时配置。
- `docker.registries`: Docker registry 上游和白名单策略。
- `docker.repositories`: 需要白名单的 Docker 镜像仓库。

排序和去重：

```bash
pnpm sort:settings
```

排序规则：

- 数组会去重。
- 包含 `*` 的规则排在前面。
- 其余内容按字母顺序排序。

## 部署

项目使用 Wrangler 部署到 Cloudflare Workers：

```bash
pnpm deploy
```

GitHub Actions 会在 `master` 分支 push 后执行部署流程。

## [License](./LICENSE)
