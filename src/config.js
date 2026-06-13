import settings from "./settings.json";

export const GITHUB = {
  owners: settings.github.owners,
  repositories: settings.github.repositories,
  pathPattern: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(releases|archive|raw)\/(.+)$/i,
};

export const DOCKER = {
  defaultRegistry: settings.docker.defaultRegistry,
  defaultNamespace: settings.docker.defaultNamespace,
  registries: settings.docker.registries,
  repositories: settings.docker.repositories,
};

export const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proxy Worker</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fa; color: #1f2328; }
    main { width: min(960px, calc(100vw - 32px)); margin: 0 auto; padding: 40px 0; }
    h1 { font-size: 32px; margin: 0 0 8px; }
    h2 { font-size: 20px; margin: 32px 0 12px; }
    h3 { font-size: 16px; margin: 20px 0 8px; }
    p { line-height: 1.6; margin: 8px 0; }
    a { color: #0969da; }
    code { background: #eaeef2; border-radius: 4px; padding: 2px 5px; }
    pre { margin: 10px 0; overflow-x: auto; border: 1px solid #d8dee4; border-radius: 6px; background: #f6f8fa; padding: 12px; }
    pre code { background: transparent; padding: 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #d8dee4; padding: 8px 10px; text-align: left; }
    th { background: #f6f8fa; }
    ul { padding-left: 22px; }
    .lead { color: #59636e; font-size: 16px; margin-bottom: 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .section { border-top: 1px solid #d8dee4; margin-top: 32px; padding-top: 24px; }
    @media (max-width: 720px) {
      main { width: min(100vw - 24px, 960px); padding: 24px 0; }
      h1 { font-size: 28px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Proxy Worker</h1>
    <p class="lead">GitHub file proxy and Docker registry proxy.</p>

    <h2>Endpoints</h2>
    <table>
      <thead>
        <tr><th>Network</th><th>URL</th></tr>
      </thead>
      <tbody>
        <tr><td>Cloudflare global</td><td><a href="https://proxy.starudream.cn/">https://proxy.starudream.cn/</a></td></tr>
        <tr><td>Tencent Cloud EdgeOne China</td><td><a href="https://proxy.52xckl.cn/">https://proxy.52xckl.cn/</a></td></tr>
      </tbody>
    </table>
    <p>Examples below use <code>proxy.starudream.cn</code>. Use <code>proxy.52xckl.cn</code> for the China endpoint.</p>

    <section class="section">
      <h2>GitHub Proxy</h2>
      <p>Supported GitHub paths are <code>releases</code>, <code>archive</code>, and <code>raw</code> for repositories allowed in <code>src/settings.json</code>.</p>

      <h3>Full URL</h3>
      <pre><code>curl -L https://proxy.starudream.cn/github/https://github.com/k3s-io/k3s/releases/download/v1.33.1%2Bk3s1/k3s</code></pre>

      <h3>Short URL</h3>
      <pre><code>curl -L https://proxy.starudream.cn/k3s-io/k3s/raw/refs/tags/v1.33.1%2Bk3s1/install.sh</code></pre>
      <pre><code>curl -L https://proxy.starudream.cn/fatedier/frp/releases/download/v0.62.1/frp_0.62.1_linux_amd64.tar.gz</code></pre>
    </section>

    <section class="section">
      <h2>Docker Proxy</h2>
      <p>Use the proxy host as a Docker registry prefix.</p>

      <h3>Docker Hub</h3>
      <pre><code>docker pull proxy.starudream.cn/docker.io/library/hello-world:latest
docker pull proxy.starudream.cn/library/hello-world:latest
docker pull proxy.starudream.cn/hello-world:latest</code></pre>
      <p>These commands all resolve to <code>docker.io/library/hello-world:latest</code>. The default registry is <code>docker.io</code>, and the default namespace is <code>library</code>.</p>

      <h3>Other Registries</h3>
      <pre><code>docker pull proxy.starudream.cn/ghcr.io/home-assistant/home-assistant:latest
docker pull proxy.starudream.cn/registry.k8s.io/pause:3.10
docker pull proxy.starudream.cn/mcr.microsoft.com/dotnet/runtime:9.0
docker pull proxy.starudream.cn/quay.io/prometheus/prometheus:latest</code></pre>

      <div class="grid">
        <div>
          <h3>Allowlist Required</h3>
          <ul>
            <li><code>docker.io</code></li>
            <li><code>gcr.io</code></li>
            <li><code>ghcr.io</code></li>
            <li><code>quay.io</code></li>
          </ul>
        </div>
        <div>
          <h3>No Allowlist</h3>
          <ul>
            <li><code>registry.k8s.io</code></li>
            <li><code>mcr.microsoft.com</code></li>
            <li><code>docker.elastic.co</code></li>
          </ul>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
