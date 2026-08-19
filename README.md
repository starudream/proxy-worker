# Proxy Worker

[English](./README.md) | [简体中文](./README.zh_CN.md)

A Cloudflare Workers proxy service for GitHub file downloads and Docker registry mirror traffic.

## Endpoints

| Route                               | URL                           |
|-------------------------------------|-------------------------------|
| Global Cloudflare                   | <https://proxy.starudream.cn> |
| Tencent Cloud EO for mainland China | <https://proxy.52xckl.cn>     |

The examples below use `https://proxy.starudream.cn` by default. For mainland China networks, replace the domain with `https://proxy.52xckl.cn`.

## GitHub Proxy

The GitHub proxy downloads allowlisted GitHub release, archive, and raw files.

### Full URL

Append the GitHub URL to the proxy endpoint:

```bash
curl -L https://proxy.starudream.cn/github/https://github.com/k3s-io/k3s/releases/download/v1.33.1%2Bk3s1/k3s
```

The `/github/` prefix can also be omitted:

```bash
curl -L https://proxy.starudream.cn/https://github.com/k3s-io/k3s/releases/download/v1.33.1%2Bk3s1/k3s
```

### Short Path

The proxy supports `owner/repo/releases/...`, `owner/repo/archive/...`, and `owner/repo/raw/...` paths:

```bash
curl -L https://proxy.starudream.cn/k3s-io/k3s/raw/refs/tags/v1.33.1%2Bk3s1/install.sh
```

```bash
curl -L https://proxy.starudream.cn/fatedier/frp/releases/download/v0.62.1/frp_0.62.1_linux_amd64.tar.gz
```

The current GitHub allowlist is maintained in [`src/settings.json`](./src/settings.json).

Workers Logs records a structured `github proxy completed` event after an allowed GitHub request receives its upstream response. The `owner`, `repository`, `resource`, `path`, `upstreamHost`, `status`, and `redirected` fields describe the proxied request without recording URL query parameters.

## Docker Proxy

The Docker proxy can be used as a registry mirror. Put the image path after the proxy domain:

```bash
docker pull proxy.starudream.cn/docker.io/library/hello-world:latest
```

Mainland China route:

```bash
docker pull proxy.52xckl.cn/docker.io/library/hello-world:latest
```

### Docker Hub Defaults

`docker.io` is the default registry, and `library` is the default namespace. These three forms are equivalent:

```bash
docker pull proxy.starudream.cn/docker.io/library/hello-world:latest
docker pull proxy.starudream.cn/library/hello-world:latest
docker pull proxy.starudream.cn/hello-world:latest
```

All of them proxy to:

```text
docker.io/library/hello-world:latest
```

### Other Registries

Put the registry explicitly at the beginning of the image path:

```bash
docker pull proxy.starudream.cn/ghcr.io/home-assistant/home-assistant:latest
docker pull proxy.starudream.cn/registry.k8s.io/pause:3.10
docker pull proxy.starudream.cn/mcr.microsoft.com/dotnet/runtime:9.0
docker pull proxy.starudream.cn/quay.io/prometheus/prometheus:latest
```

Currently supported registries:

| Registry            | Allowlist Required |
|---------------------|--------------------|
| `docker.io`         | Yes                |
| `gcr.io`            | Yes                |
| `ghcr.io`           | Yes                |
| `quay.io`           | Yes                |
| `registry.k8s.io`   | No                 |
| `mcr.microsoft.com` | No                 |
| `docker.elastic.co` | No                 |

Registries that require an allowlist only proxy image repositories configured in [`src/settings.json`](./src/settings.json).

### Upstream Priority

After the allowlist check, image pull requests try applicable accelerators in this order: DaoCloud, Docker Proxy, SparkCR, 1ms, and Xuanyuan. Accelerators that do not serve the requested registry are skipped; Docker Proxy and Xuanyuan serve Docker Hub only, DaoCloud and 1ms serve both Docker Hub and GHCR, and SparkCR serves every configured registry. If every applicable accelerator fails, the request falls back to the configured source registry.

Accelerator manifests and uncached blobs are streamed through the Worker. Redirects for cached blobs are returned directly to Docker, so the blob data does not pass through the Worker. A response that fails after streaming has started cannot be retried through another accelerator or the source registry.

Set the `XUANYUAN_USERNAME` and `XUANYUAN_PASSWORD` Worker secrets before deployment. If either secret is unavailable, Docker Hub requests skip the accelerator and use the source registry.

Workers Logs records a structured `docker upstream selected` event for each manifest, blob, tag list, or referrers request. The `registry`, `repository`, `resource`, `upstream`, `upstreamHost`, and `status` fields identify the selected upstream. Manifest events also include `reference`. Origin events include `fallbackReason` and an `acceleratorAttempts` list when accelerators were attempted. Token and registry probe requests are not recorded by this custom log.

Automatic invocation logs are disabled; Workers Logs retains the GitHub and Docker structured application events described above.

## Configuration

Main configuration lives in [`src/settings.json`](./src/settings.json):

- `github.owners`: GitHub owners allowed by the proxy.
- `github.repositories`: GitHub repositories allowed by the proxy.
- `docker.accelerators`: Ordered Docker accelerators, enablement, registry scope, authentication, and timeout settings.
- `docker.registries`: Docker registry upstreams and allowlist policies.
- `docker.repositories`: Docker image repositories that require allowlisting.

Sort and deduplicate the configuration:

```bash
pnpm sort:settings
```

Sorting rules:

- Arrays are deduplicated.
- Rules containing `*` are placed first.
- Other entries are sorted alphabetically.

## Deployment

This project deploys to Cloudflare Workers with Wrangler:

```bash
pnpm deploy
```

GitHub Actions runs the deployment workflow after pushes to the `master` branch.

## [License](./LICENSE)
