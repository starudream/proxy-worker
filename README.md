# Proxy Worker

A Cloudflare Workers proxy service for GitHub file downloads and Docker registry mirror traffic.

## Endpoints

| Route | URL |
|-------|-----|
| Global Cloudflare | <https://proxy.starudream.cn> |
| Tencent Cloud EO for mainland China | <https://proxy.52xckl.cn> |

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

The current GitHub allowlist is maintained in `src/settings.json`:

- owners: `docker`, `istio`, `k3s-io`, `starudream`
- repositories: `fatedier/frp`

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

| Registry | Allowlist Required |
|----------|--------------------|
| `docker.io` | Yes |
| `gcr.io` | Yes |
| `ghcr.io` | Yes |
| `quay.io` | Yes |
| `registry.k8s.io` | No |
| `mcr.microsoft.com` | No |
| `docker.elastic.co` | No |

Registries that require an allowlist only proxy image repositories configured in `src/settings.json`. The current list includes:

- `docker.io/library/*`
- `docker.io/starudream/*`
- `ghcr.io/starudream/*`
- `docker.io/binwiederhier/ntfy`
- `docker.io/blinkospace/blinko`
- `docker.io/calciumion/new-api`
- `docker.io/casbin/casdoor`
- `docker.io/clickhouse/clickhouse-server`
- `docker.io/couchdb`
- `docker.io/dbeaver/cloudbeaver`
- `docker.io/diygod/rsshub`
- `docker.io/erikdubbelboer/phpredisadmin`
- `docker.io/freshrss/freshrss`
- `docker.io/grafana/grafana-oss`
- `docker.io/headscale/headscale`
- `docker.io/langfuse/langfuse`
- `docker.io/langfuse/langfuse-worker`
- `docker.io/lobehub/lobehub`
- `docker.io/paradedb/paradedb`
- `docker.io/prom/alertmanager`
- `docker.io/prom/node-exporter`
- `docker.io/prom/prometheus`
- `docker.io/redis`
- `docker.io/searxng/searxng`
- `docker.io/vaultwarden/server`
- `docker.io/victoriametrics/victoria-metrics`
- `docker.io/weishaw/sub2api`
- `ghcr.io/berriai/litellm`
- `ghcr.io/home-assistant/home-assistant`
- `ghcr.io/starudream/sign-task`

The complete allowlist is defined in `src/settings.json`.

## Configuration

Main configuration lives in `src/settings.json`:

- `github.owners`: GitHub owners allowed by the proxy.
- `github.repositories`: GitHub repositories allowed by the proxy.
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
