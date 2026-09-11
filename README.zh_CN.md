# Proxy Worker

[English](./README.md) | [简体中文](./README.zh_CN.md)

边缘代理服务，提供 GitHub 文件代理和 Docker registry 镜像代理。

## 访问地址

| 平台                    | 地址                              |
|-------------------------|-----------------------------------|
| Cloudflare Worker       | <https://proxy.starudream.cn>     |
| 阿里云 ESA              | <https://proxy.52xckl.cn>         |
| 阿里云 ESA（显式线路）  | <https://proxy-esa.52xckl.cn>     |
| 腾讯云 TEO              | <https://proxy-teo.52xckl.cn>     |

下文示例默认使用 `https://proxy.starudream.cn`。国内网络可使用阿里云 ESA 入口 `https://proxy.52xckl.cn`，也可以通过上表的显式入口手动选择 ESA 或 TEO。

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

允许的 GitHub 请求取得上游响应后，Workers Logs 会记录一条结构化的 `github proxy completed` 事件。通过 `owner`、`repository`、`resource`、`path`、`upstreamHost`、`status` 和 `redirected` 字段可以确认代理请求，日志不会记录
URL 查询参数。

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
docker pull proxy.starudream.cn/registry.gitlab.com/gitlab-org/gitlab-runner:latest
docker pull proxy.starudream.cn/registry.k8s.io/pause:3.10
docker pull proxy.starudream.cn/mcr.microsoft.com/dotnet/runtime:9.0
docker pull proxy.starudream.cn/quay.io/prometheus/prometheus:latest
```

当前支持的 registry：

| Registry              | 是否需要白名单 |
|-----------------------|----------------|
| `docker.io`           | 是             |
| `gcr.io`              | 是             |
| `ghcr.io`             | 是             |
| `quay.io`             | 是             |
| `registry.gitlab.com` | 是             |
| `registry.k8s.io`     | 否             |
| `mcr.microsoft.com`   | 否             |
| `docker.elastic.co`   | 否             |

需要白名单的 registry 只允许 [`src/settings.json`](./src/settings.json) 中配置的镜像仓库。

### 上游优先级

镜像拉取请求通过白名单检查后，按 DaoCloud、Docker Proxy、SparkCR、1ms、轩辕的顺序尝试适用于当前 registry 的加速服务。不支持当前 registry 的服务会被跳过：本配置中 Docker Proxy 和轩辕仅用于 Docker Hub，DaoCloud
和 1ms 同时用于 Docker Hub 与 GHCR，SparkCR 用于其明确配置的 registry；GitLab Container Registry 当前直接使用源 registry。所有适用的加速服务都失败后，才回退到配置的源 registry。

加速服务的 manifest 和未缓存 blob 会通过 Worker 流式返回；已缓存 blob 的 HTTPS 重定向会直接返回给 Docker，使 blob 数据不经过 Worker。重定向目标为 `docker.com` 或其子域名时，当前加速服务会被视为失败并继续尝试下一个，避免
Docker 客户端直连国内不可访问的地址。响应开始流式传输后发生的错误无法再回退到其他加速服务或源 registry。

部署前需设置 `XUANYUAN_USERNAME` 和 `XUANYUAN_PASSWORD` Worker Secret。任一 Secret 缺失时，Docker Hub 请求会跳过加速并使用源 registry。

Workers Logs 会为每个 manifest、blob、标签列表或 referrers 请求记录一条结构化的 `docker upstream selected` 事件。通过 `registry`、`repository`、`resource`、`upstream`、`upstreamHost` 和 `status`
字段可以确认实际选中的上游；manifest 事件还包含 `reference`。源 registry 事件还包含 `fallbackReason`，尝试过加速服务时同时包含 `acceleratorAttempts` 列表。自定义日志不记录
token 和 registry 探测请求。

GitHub 和 Docker 结构化事件还会在字段存在时记录长度受限的 `requestIp`、`userAgent`、`cfRay`、`country`、`accept` 和 `range`；每个请求头字段最多记录 512 个字符，不记录
`Authorization`、`Cookie` 等敏感请求头。

自动 invocation logs 已关闭，Workers Logs 仍会保留上述 GitHub 和 Docker 结构化应用日志。

## ESA/TEO 带宽检测

在需要评估的客户端网络上运行带宽诊断脚本：

```bash
bash scripts/benchmark-edge-bandwidth.sh
```

脚本通过 ESA 和 TEO 显式入口读取固定版本 `k3s-io/k3s` Release 资产 `k3s-airgap-images-amd64.tar.zst` 的前 20 MiB。默认交替测试两个入口各 3 轮，并在同一个连续 HTTP Range 响应内按 1 MiB 窗口统计速度，以便观察前若干 MiB 后是否出现持续降速；不会把样本拆成多个相互独立的 HTTP 请求。

可以通过环境变量调整采样大小、统计窗口和轮数：

```bash
SAMPLE_MIB=40 CHUNK_MIB=2 RUNS=5 bash scripts/benchmark-edge-bandwidth.sh
```

脚本报告的疑似限速边界只是诊断信号，不能单独证明云厂商实施了带宽限制。应在相同客户端和网络下分时段重复测试，并结合最终响应状态、`Content-Range`、各窗口速度和多轮结果判断；CDN 缓存状态、GitHub 源站、运营商路由及本地网络均可能影响结果。

## 配置

主要配置集中在 [`src/settings.json`](./src/settings.json)：

- `github.owners`: 允许代理的 GitHub owner。
- `github.repositories`: 允许代理的 GitHub 仓库。
- `docker.accelerators`: Docker 加速服务的顺序、启用状态、registry 范围、鉴权和超时配置。
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
