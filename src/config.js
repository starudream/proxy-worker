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
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #fbfbfb; color: #202124; }
    main { width: min(560px, calc(100vw - 32px)); }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { line-height: 1.6; margin: 8px 0; }
    code { background: #f1f3f4; border-radius: 4px; padding: 2px 5px; }
  </style>
</head>
<body>
  <main>
    <h1>Proxy Worker</h1>
    <p>GitHub proxy: <code>/github/https://github.com/owner/repo/releases/...</code></p>
    <p>Docker registry proxy: configure this Worker as a registry mirror and allow repositories in <code>src/settings.json</code>. <code>docker.io/library/hello-world</code>, <code>library/hello-world</code>, and <code>hello-world</code> resolve to the same Docker Hub image.</p>
  </main>
</body>
</html>`;
