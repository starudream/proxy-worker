# Proxy Worker

[English](./README.md) | [简体中文](./README.zh_CN.md)

An edge proxy service for GitHub file downloads and Docker registry mirror traffic.

## Endpoints

| Platform                         | URL                               |
|----------------------------------|-----------------------------------|
| Cloudflare Worker                | <https://proxy.starudream.cn>     |
| Alibaba Cloud ESA                | <https://proxy.52xckl.cn>         |
| Alibaba Cloud ESA (explicit)     | <https://proxy-esa.52xckl.cn>     |
| Tencent Cloud TEO                | <https://proxy-teo.52xckl.cn>     |

The examples below use `https://proxy.starudream.cn` by default. For mainland China networks, use the Alibaba Cloud ESA endpoint `https://proxy.52xckl.cn`, or explicitly select ESA or TEO with the corresponding endpoint above.

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

Workers Logs records a structured `github proxy completed` event after an allowed GitHub request receives its upstream response. The `owner`, `repository`, `resource`, `path`, `upstreamHost`,
`status`, and `redirected` fields describe the proxied request without recording URL query parameters.

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
docker pull proxy.starudream.cn/registry.gitlab.com/gitlab-org/gitlab-runner:latest
docker pull proxy.starudream.cn/registry.k8s.io/pause:3.10
docker pull proxy.starudream.cn/mcr.microsoft.com/dotnet/runtime:9.0
docker pull proxy.starudream.cn/quay.io/prometheus/prometheus:latest
```

Currently supported registries:

| Registry              | Allowlist Required |
|-----------------------|--------------------|
| `docker.io`           | Yes                |
| `gcr.io`              | Yes                |
| `ghcr.io`             | Yes                |
| `quay.io`             | Yes                |
| `registry.gitlab.com` | Yes                |
| `registry.k8s.io`     | No                 |
| `mcr.microsoft.com`   | No                 |
| `docker.elastic.co`   | No                 |

Registries that require an allowlist only proxy image repositories configured in [`src/settings.json`](./src/settings.json).

### Upstream Priority

After the allowlist check, image pull requests try applicable accelerators in this order: DaoCloud, Docker Proxy, SparkCR, 1ms, and Xuanyuan. Accelerators that do not serve the requested registry are
skipped; Docker Proxy and Xuanyuan serve Docker Hub only, DaoCloud and 1ms serve both Docker Hub and GHCR, and SparkCR serves its configured registries. GitLab Container Registry currently uses its
source registry directly. If every applicable accelerator fails, the request falls back to the configured source registry.

Accelerator manifests and uncached blobs are streamed through the Worker. HTTPS redirects for cached blobs are returned directly to Docker, so the blob data does not pass through the Worker. If the
redirect target is `docker.com` or one of its subdomains, the current accelerator is treated as failed and the next one is tried, preventing the Docker client from connecting directly to an address
that is unreachable from China. A response that fails after streaming has started cannot be retried through another accelerator or the source registry.

Set the `XUANYUAN_USERNAME` and `XUANYUAN_PASSWORD` Worker secrets before deployment. If either secret is unavailable, Docker Hub requests skip the accelerator and use the source registry.

Workers Logs records a structured `docker upstream selected` event for each manifest, blob, tag list, or referrers request. The `registry`, `repository`, `resource`, `upstream`, `upstreamHost`, and
`status` fields identify the selected upstream. Manifest events also include `reference`. Origin events include `fallbackReason` and an `acceleratorAttempts` list when accelerators were attempted.
Token and registry probe requests are not recorded by this custom log.

The GitHub and Docker structured events also include the bounded request fields `requestIp`, `userAgent`, `cfRay`, `country`, `accept`, and `range` when available. Header values are limited to 512
characters. Sensitive headers such as `Authorization` and `Cookie` are not recorded.

Automatic invocation logs are disabled; Workers Logs retains the GitHub and Docker structured application events described above.

## ESA/TEO Bandwidth Check

Run the bandwidth diagnostic script from a client on the network being evaluated:

```bash
bash scripts/benchmark-edge-bandwidth.sh
```

The script requests the first 20 MiB of the pinned `k3s-io/k3s` release asset `k3s-airgap-images-amd64.tar.zst` through the explicit ESA and TEO endpoints. Each endpoint is tested three times in alternating order. A single continuous HTTP Range response is measured in 1 MiB windows so that a sustained speed change after the first few MiB remains visible. It does not split the sample into independent HTTP requests.

The sample size, window size, and number of rounds can be adjusted without editing the script:

```bash
SAMPLE_MIB=40 CHUNK_MIB=2 RUNS=5 bash scripts/benchmark-edge-bandwidth.sh
```

The reported throttle boundary is a heuristic signal rather than proof of a provider-side limit. Repeat the test from the same client and network at different times, and compare the final response status, `Content-Range`, per-window rates, and repeated results. CDN cache state, the GitHub origin, ISP routing, and the local network can all affect throughput.

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
