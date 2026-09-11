import { DOCKER } from "./config";
import { commaList, copyProxyHeaders, corsPreflight, isAllowed, requestBody, requestLogFields, textResponse } from "./http";

const DOCKER_HUB_REGISTRY = "docker.io";
const MAX_ACCELERATOR_REDIRECTS = 5;

function getConfiguredList(envValue, fallback) {
  if (!envValue) {
    return fallback;
  }

  return commaList(envValue);
}

function normalizeDockerHubRepository(repository) {
  if (repository.includes("/")) {
    return repository;
  }

  return `${DOCKER.defaultNamespace}/${repository}`;
}

function resolveRegistry(name) {
  const normalizedName = name.toLowerCase();
  for (const [ registryName, registry ] of Object.entries(DOCKER.registries)) {
    if (registryName === normalizedName || registry.aliases.includes(normalizedName)) {
      return { name: registryName, ...registry };
    }
  }

  return null;
}

function defaultRegistry() {
  return resolveRegistry(DOCKER.defaultRegistry);
}

function normalizeRepositoryForRegistry(repository, registry) {
  const parts = repository.split("/").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }

  const explicitRegistry = resolveRegistry(parts[0]);
  if (explicitRegistry && explicitRegistry.name === registry.name) {
    return normalizeRepositoryForRegistry(parts.slice(1).join("/"), registry);
  }

  if (registry.name === DOCKER_HUB_REGISTRY) {
    return normalizeDockerHubRepository(parts.join("/"));
  }

  return parts.join("/");
}

function parseRepositoryReference(repositoryReference) {
  const parts = repositoryReference.split("/").filter(Boolean);
  const registry = resolveRegistry(parts[0]);

  if (registry) {
    return {
      registry,
      repository: normalizeRepositoryForRegistry(parts.slice(1).join("/"), registry),
    };
  }

  const fallbackRegistry = defaultRegistry();
  return {
    registry: fallbackRegistry,
    repository: normalizeRepositoryForRegistry(parts.join("/"), fallbackRegistry),
  };
}

function getDockerRoute(pathname) {
  if (pathname === "/v2" || pathname === "/v2/") {
    return {
      registry: null,
      repository: null,
      upstreamPath: "/v2/",
    };
  }

  const match = /^\/v2\/(.+)\/(manifests\/.+|blobs\/.+|tags\/list(?:\/.*)?|referrers(?:\/.*)?)$/.exec(pathname);
  if (!match) {
    return null;
  }

  const parsedReference = parseRepositoryReference(match[1]);
  if (!parsedReference.repository) {
    return null;
  }

  return {
    registry: parsedReference.registry,
    repository: parsedReference.repository,
    upstreamPath: `/v2/${parsedReference.repository}/${match[2]}`,
  };
}

function getDockerContext(url) {
  if (url.pathname === "/token") {
    const registry = resolveRegistry(url.searchParams.get("ns") || url.searchParams.get("hubhost") || DOCKER.defaultRegistry);
    return {
      registry,
      repository: null,
      upstreamPath: "/token",
    };
  }

  return getDockerRoute(url.pathname);
}

function getTokenScopes(url) {
  return url.searchParams
    .getAll("scope")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseTokenScope(scope, fallbackRegistry) {
  const match = /^repository:([^:]+):(.+)$/.exec(scope);
  if (!match) {
    return null;
  }

  const parts = match[1].split("/").filter(Boolean);
  const explicitRegistry = resolveRegistry(parts[0]);
  const registry = explicitRegistry || fallbackRegistry || defaultRegistry();
  const repository = normalizeRepositoryForRegistry(match[1], registry);
  if (!repository) {
    return null;
  }

  return {
    registry,
    repository,
    upstreamScope: `repository:${repository}:${match[2]}`,
  };
}

function getTokenScopeRequests(scopes, fallbackRegistry) {
  return scopes.map((scope) => parseTokenScope(scope, fallbackRegistry)).filter(Boolean);
}

function getTokenRegistry(scopeRequests, fallbackRegistry) {
  if (scopeRequests.length === 0) {
    return fallbackRegistry || defaultRegistry();
  }

  const registry = scopeRequests[0].registry;
  if (!scopeRequests.every((scopeRequest) => scopeRequest.registry.name === registry.name)) {
    return null;
  }

  return registry;
}

function repositoryAllowKeys(repository, registry) {
  const keys = [ `${registry.name}/${repository}`, `${registry.host}/${repository}` ];
  if (registry.name === DOCKER_HUB_REGISTRY) {
    keys.push(repository);
  }

  return keys;
}

function assertRepositoryAllowed(repository, registry, env) {
  if (!registry.requireAllowlist) {
    return null;
  }

  const allowList = getConfiguredList(env.DOCKER_REPO_ALLOWLIST, DOCKER.repositories);
  if (allowList.length === 0 || !repositoryAllowKeys(repository, registry).some((key) => isAllowed(key, allowList))) {
    return textResponse("forbidden", 403);
  }

  return null;
}

function buildAcceleratorHeaders(request, accelerator, token) {
  const headers = buildDockerHeaders(request, accelerator.host);
  headers.delete("Cookie");
  headers.delete("Authorization");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function getAcceleratorTokenUrl(accelerator, repository) {
  const tokenUrl = new URL(accelerator.authPath, `https://${accelerator.host}`);
  tokenUrl.searchParams.set("service", accelerator.authService || accelerator.host);
  tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);
  return tokenUrl;
}

async function withAcceleratorTimeout(accelerator, callback) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), accelerator.timeoutMs);
  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function getAcceleratorCredentials(accelerator, env) {
  if (!accelerator.usernameEnv && !accelerator.passwordEnv) {
    return null;
  }

  const username = env[accelerator.usernameEnv];
  const password = env[accelerator.passwordEnv];
  if (!username || !password) {
    return undefined;
  }

  return btoa(`${username}:${password}`);
}

async function fetchAcceleratorToken(accelerator, repository, env) {
  if (!accelerator.authPath) {
    return {
      token: null,
      status: undefined,
    };
  }

  const credentials = getAcceleratorCredentials(accelerator, env);
  if (credentials === undefined) {
    return {
      token: null,
      status: undefined,
      credentialsUnavailable: true,
    };
  }

  return withAcceleratorTimeout(accelerator, async (signal) => {
    const headers = new Headers({
      "Accept": "application/json",
    });
    if (credentials) {
      headers.set("Authorization", `Basic ${credentials}`);
    }

    const response = await fetch(getAcceleratorTokenUrl(accelerator, repository), {
      headers,
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        token: null,
        status: response.status,
      };
    }

    const data = await response.json();
    return {
      token: data.token || data.access_token || null,
      status: response.status,
    };
  });
}

function getAcceleratorUrl(accelerator, url, context) {
  const acceleratorUrl = new URL(getUpstreamSearch(url), `https://${accelerator.host}`);
  acceleratorUrl.pathname = accelerator.includeRegistryInPath
    ? context.upstreamPath.replace("/v2/", `/v2/${context.registry.name}/`)
    : context.upstreamPath;
  return acceleratorUrl;
}

function isRedirectResponse(response) {
  return [ 301, 302, 303, 307, 308 ].includes(response.status);
}

function isBlobRequest(context) {
  return context.upstreamPath.includes("/blobs/");
}

function streamBufferedChunks(chunks, reader) {
  let chunkIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex]);
        chunkIndex += 1;
        return;
      }

      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }

        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function readWithTimeout(reader, timeoutMs) {
  let timeout;
  const read = reader.read().then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  const expired = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([ read, expired ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function probeAcceleratorBandwidth(response) {
  const probe = DOCKER.bandwidthProbe;
  if (!probe || !response.body) {
    return { response };
  }

  const contentLengthValue = response.headers.get("Content-Length");
  const contentLength = contentLengthValue === null ? Number.NaN : Number(contentLengthValue);
  if (Number.isFinite(contentLength) && contentLength >= 0 && contentLength < probe.minBytes) {
    return {
      response,
      probe: {
        bandwidthProbeSkipped: "content_length_below_threshold",
      },
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  const startedAt = Date.now();
  const deadline = startedAt + probe.durationMs;
  let bytes = 0;

  while (bytes < probe.minBytes) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await reader.cancel("accelerator bandwidth below threshold");
      const durationMs = Date.now() - startedAt;
      return {
        response: null,
        fallbackReason: "accelerator_bandwidth_below_threshold",
        bandwidthProbeBytes: bytes,
        bandwidthProbeDurationMs: durationMs,
        bandwidthProbeBytesPerSecond: Math.round(bytes * 1000 / Math.max(durationMs, 1)),
      };
    }

    const read = await readWithTimeout(reader, remainingMs);
    if (read.timedOut) {
      await reader.cancel("accelerator bandwidth below threshold");
      const durationMs = Date.now() - startedAt;
      return {
        response: null,
        fallbackReason: "accelerator_bandwidth_below_threshold",
        bandwidthProbeBytes: bytes,
        bandwidthProbeDurationMs: durationMs,
        bandwidthProbeBytesPerSecond: Math.round(bytes * 1000 / Math.max(durationMs, 1)),
      };
    }
    if (read.error) {
      throw read.error;
    }
    if (read.result.done) {
      return {
        response: new Response(streamBufferedChunks(chunks, reader), response),
        probe: {
          bandwidthProbeBytes: bytes,
          bandwidthProbeDurationMs: Date.now() - startedAt,
          bandwidthProbeCompleted: true,
        },
      };
    }

    chunks.push(read.result.value);
    bytes += read.result.value.byteLength;
  }

  const durationMs = Date.now() - startedAt;
  return {
    response: new Response(streamBufferedChunks(chunks, reader), response),
    probe: {
      bandwidthProbeBytes: bytes,
      bandwidthProbeDurationMs: durationMs,
      bandwidthProbeBytesPerSecond: Math.round(bytes * 1000 / Math.max(durationMs, 1)),
    },
  };
}

async function followAcceleratorRedirects(request, accelerator, response, responseUrl) {
  let currentResponse = response;
  let currentUrl = responseUrl;
  let redirects = 0;

  while (isRedirectResponse(currentResponse)) {
    if (redirects >= MAX_ACCELERATOR_REDIRECTS) {
      await currentResponse.body?.cancel();
      return {
        response: null,
        fallbackReason: "accelerator_redirect_limit_exceeded",
        acceleratorStatus: currentResponse.status,
      };
    }

    const location = currentResponse.headers.get("Location");
    if (!location) {
      await currentResponse.body?.cancel();
      return {
        response: null,
        fallbackReason: "accelerator_redirect_location_missing",
        acceleratorStatus: currentResponse.status,
      };
    }

    let redirectUrl;
    try {
      redirectUrl = new URL(location, currentUrl);
    } catch {
      await currentResponse.body?.cancel();
      return {
        response: null,
        fallbackReason: "accelerator_redirect_invalid",
        acceleratorStatus: currentResponse.status,
      };
    }
    if (redirectUrl.protocol !== "https:") {
      await currentResponse.body?.cancel();
      return {
        response: null,
        fallbackReason: "accelerator_redirect_insecure",
        acceleratorStatus: currentResponse.status,
      };
    }

    await currentResponse.body?.cancel();
    currentResponse = await withAcceleratorTimeout(accelerator, (signal) => fetch(redirectUrl, {
      method: request.method,
      headers: buildRedirectHeaders(request),
      redirect: "manual",
      signal,
    }));
    currentUrl = redirectUrl;
    redirects += 1;
  }

  return {
    response: currentResponse,
    redirectHost: redirects > 0 ? currentUrl.hostname : undefined,
    redirectCount: redirects || undefined,
  };
}

function getDockerResource(context) {
  const resourcePath = context.upstreamPath.slice(`/v2/${context.repository}/`.length);
  if (resourcePath.startsWith("manifests/")) {
    return {
      type: "manifest",
      reference: resourcePath.slice("manifests/".length),
    };
  }

  if (resourcePath.startsWith("blobs/")) {
    return { type: "blob" };
  }

  if (resourcePath.startsWith("tags/list")) {
    return { type: "tags" };
  }

  if (resourcePath.startsWith("referrers/")) {
    return { type: "referrers" };
  }

  return { type: "unknown" };
}

function logDockerUpstream(request, context, upstream, upstreamHost, status, fallback = {}) {
  const resource = getDockerResource(context);
  const log = {
    message: "docker upstream selected",
    method: request.method,
    registry: context.registry.name,
    repository: context.repository,
    resource: resource.type,
    upstream,
    upstreamHost,
    status,
    ...requestLogFields(request),
    ...fallback,
  };
  if (resource.reference) {
    log.reference = resource.reference;
  }

  console.log(log);
}

function resolveDockerAccelerator(accelerator, registryName) {
  if (!accelerator.enabled) {
    return null;
  }

  if (accelerator.hosts) {
    const host = accelerator.hosts[registryName];
    return host ? { ...accelerator, host } : null;
  }

  if (!accelerator.registries.includes(registryName)) {
    return null;
  }

  return accelerator;
}

function getDockerAccelerators(context) {
  return DOCKER.accelerators
    .map((accelerator) => resolveDockerAccelerator(accelerator, context.registry.name))
    .filter(Boolean);
}

async function fetchDockerAccelerator(request, url, context, env, accelerator) {
  try {
    const tokenResponse = await fetchAcceleratorToken(accelerator, context.repository, env);
    if (accelerator.authPath && !tokenResponse.token) {
      return {
        response: null,
        fallbackReason: tokenResponse.credentialsUnavailable ? "accelerator_credentials_unavailable" : "token_unavailable",
        acceleratorStatus: tokenResponse.status,
      };
    }

    const acceleratorUrl = getAcceleratorUrl(accelerator, url, context);
    let response = await withAcceleratorTimeout(accelerator, (signal) => fetch(acceleratorUrl, {
      method: request.method,
      headers: buildAcceleratorHeaders(request, accelerator, tokenResponse.token),
      redirect: "manual",
      signal,
    }));

    let redirect = {};
    if (isBlobRequest(context) && request.method.toUpperCase() === "GET" && isRedirectResponse(response)) {
      redirect = await followAcceleratorRedirects(request, accelerator, response, acceleratorUrl);
      if (!redirect.response) {
        return redirect;
      }
      response = redirect.response;
    }

    const headers = copyProxyHeaders(response.headers);

    if (response.ok) {
      let result = { response };
      if (isBlobRequest(context) && request.method.toUpperCase() === "GET") {
        result = await probeAcceleratorBandwidth(response);
        if (!result.response) {
          return {
            ...result,
            acceleratorStatus: response.status,
            redirectHost: redirect.redirectHost,
            redirectCount: redirect.redirectCount,
          };
        }
      }

      return {
        response: new Response(result.response.body, {
          status: response.status,
          headers,
        }),
        acceleratorStatus: response.status,
        redirectHost: redirect.redirectHost,
        redirectCount: redirect.redirectCount,
        ...result.probe,
      };
    }

    const location = headers.get("Location");
    if (location && isBlobRequest(context) && isRedirectResponse(response)) {
      const redirectUrl = new URL(location, acceleratorUrl);
      if (redirectUrl.protocol === "https:") {
        if (redirectUrl.hostname === "docker.com" || redirectUrl.hostname.endsWith(".docker.com")) {
          await response.body?.cancel();
          return {
            response: null,
            fallbackReason: "accelerator_redirect_host_unreachable",
            acceleratorStatus: response.status,
          };
        }

        headers.set("Location", redirectUrl.href);
        return {
          response: new Response(response.body, {
            status: response.status,
            headers,
          }),
          acceleratorStatus: response.status,
        };
      }
    }

    await response.body?.cancel();
    return {
      response: null,
      fallbackReason: "accelerator_response_not_ok",
      acceleratorStatus: response.status,
    };
  } catch (error) {
    return {
      response: null,
      fallbackReason: error?.name === "AbortError" ? "accelerator_timeout" : "accelerator_request_error",
    };
  }
}

async function fetchDockerAccelerators(request, url, context, env) {
  const accelerators = getDockerAccelerators(context);
  if (accelerators.length === 0) {
    return {
      response: null,
      fallbackReason: "accelerator_not_configured",
      attempts: [],
    };
  }

  if (![ "GET", "HEAD" ].includes(request.method.toUpperCase())) {
    return {
      response: null,
      fallbackReason: "method_not_supported",
      attempts: [],
    };
  }

  const attempts = [];
  for (const accelerator of accelerators) {
    const result = await fetchDockerAccelerator(request, url, context, env, accelerator);
    if (result.response) {
      const details = {};
      for (const field of [
        "redirectHost",
        "redirectCount",
        "bandwidthProbeSkipped",
        "bandwidthProbeBytes",
        "bandwidthProbeDurationMs",
        "bandwidthProbeBytesPerSecond",
        "bandwidthProbeCompleted",
      ]) {
        if (result[field] !== undefined) {
          details[field] = result[field];
        }
      }
      if (attempts.length > 0) {
        details.acceleratorAttempts = attempts;
      }
      logDockerUpstream(request, context, accelerator.name, accelerator.host, result.acceleratorStatus, details);
      return { response: result.response };
    }

    const attempt = {
      upstream: accelerator.name,
      upstreamHost: accelerator.host,
      fallbackReason: result.fallbackReason,
    };
    if (result.acceleratorStatus !== undefined) {
      attempt.status = result.acceleratorStatus;
    }
    for (const field of [ "redirectHost", "redirectCount", "bandwidthProbeBytes", "bandwidthProbeDurationMs", "bandwidthProbeBytesPerSecond" ]) {
      if (result[field] !== undefined) {
        attempt[field] = result[field];
      }
    }
    attempts.push(attempt);
  }

  return {
    response: null,
    fallbackReason: "accelerators_exhausted",
    attempts,
  };
}

function buildDockerHeaders(request, host) {
  const headers = new Headers(request.headers);
  headers.set("Host", host);
  return headers;
}

function buildRedirectHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("Host");
  return headers;
}

function getUpstreamSearch(url) {
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("ns");
  searchParams.delete("hubhost");
  searchParams.delete("realm");
  const search = searchParams.toString();
  return search ? `?${search}` : "";
}

function isAllowedTokenRealm(realmUrl, registry) {
  if (registry.authHost) {
    return realmUrl.hostname === registry.authHost;
  }

  return realmUrl.hostname === registry.host;
}

function getDefaultTokenRealm(registry) {
  return `https://${registry.authHost || registry.host}${registry.authPath || "/token"}`;
}

function getRegistryService(registry) {
  if (registry.authService) {
    return registry.authService;
  }

  if (registry.name === DOCKER_HUB_REGISTRY) {
    return "registry.docker.io";
  }

  return registry.host;
}

function getTokenUrl(url, registry, scopeRequests) {
  const realm = url.searchParams.get("realm") || getDefaultTokenRealm(registry);
  let realmUrl;
  try {
    realmUrl = new URL(realm);
  } catch {
    return null;
  }

  if (!isAllowedTokenRealm(realmUrl, registry)) {
    return null;
  }

  const tokenUrl = new URL(realmUrl.href);
  const upstreamParams = new URLSearchParams(getUpstreamSearch(url));
  for (const [ key, value ] of upstreamParams) {
    if (key === "service" || key === "scope") {
      continue;
    }

    tokenUrl.searchParams.append(key, value);
  }
  tokenUrl.searchParams.set("service", getRegistryService(registry));
  for (const scopeRequest of scopeRequests) {
    tokenUrl.searchParams.append("scope", scopeRequest.upstreamScope);
  }
  return tokenUrl;
}

function dockerAnonymousTokenResponse() {
  return new Response(JSON.stringify({
    token: "proxy",
    access_token: "proxy",
    expires_in: 300,
    issued_at: new Date().toISOString(),
  }), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function fetchDockerToken(request, url, registry, scopeRequests) {
  if (!registry.authHost && !registry.requireAllowlist) {
    return dockerAnonymousTokenResponse();
  }

  const tokenUrl = getTokenUrl(url, registry, scopeRequests);
  if (!tokenUrl) {
    return textResponse("invalid docker token realm", 400);
  }

  return fetch(tokenUrl, {
    method: request.method,
    headers: buildDockerHeaders(request, tokenUrl.hostname),
    body: requestBody(request),
    redirect: "follow",
  });
}

async function proxyDockerRedirect(request, location, registry) {
  let redirectUrl;
  try {
    redirectUrl = new URL(location, `https://${registry.host}`);
  } catch {
    return textResponse("invalid docker redirect", 502);
  }

  const response = await fetch(redirectUrl, {
    method: request.method,
    headers: buildRedirectHeaders(request),
    body: requestBody(request),
    redirect: "follow",
  });

  const headers = copyProxyHeaders(response.headers);

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

export function isDockerRequest(url) {
  return url.pathname === "/token" || url.pathname.startsWith("/v2/");
}

function rewriteAuthenticateHeader(authenticate, origin, registry) {
  return authenticate.replace(/realm="([^"]+)"/i, (value, realm) => {
    let realmUrl;
    try {
      realmUrl = new URL(realm);
    } catch {
      return value;
    }

    if (!isAllowedTokenRealm(realmUrl, registry)) {
      return value;
    }

    const workerRealm = new URL("/token", origin);
    workerRealm.searchParams.set("ns", registry.name);
    workerRealm.searchParams.set("realm", realmUrl.href);
    return `realm="${workerRealm.href}"`;
  });
}

function dockerRegistryBaseAuthenticate(origin) {
  const tokenRealm = new URL("/token", origin);
  return `Bearer realm="${tokenRealm.href}",service="${new URL(origin).host}"`;
}

function dockerRegistryBaseResponse(origin) {
  return textResponse("authentication required", 401, {
    "Www-Authenticate": dockerRegistryBaseAuthenticate(origin),
    "Docker-Distribution-API-Version": "registry/2.0",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
  });
}

export async function handleDocker(request, env) {
  const preflight = corsPreflight(request);
  if (preflight) {
    return preflight;
  }

  const url = new URL(request.url);
  const context = getDockerContext(url);

  if (context?.upstreamPath === "/v2/") {
    return dockerRegistryBaseResponse(url.origin);
  }

  if (!context || !context.registry) {
    return textResponse("invalid docker upstream", 400);
  }

  if (context.upstreamPath === "/token") {
    const scopes = getTokenScopes(url);
    const scopeRequests = getTokenScopeRequests(scopes, context.registry);
    if (scopeRequests.length !== scopes.length) {
      return textResponse("forbidden", 403);
    }

    const tokenRegistry = getTokenRegistry(scopeRequests, context.registry);
    if (!tokenRegistry) {
      return textResponse("forbidden", 403);
    }

    for (const scopeRequest of scopeRequests) {
      const denied = assertRepositoryAllowed(scopeRequest.repository, tokenRegistry, env);
      if (denied) {
        return denied;
      }
    }

    return fetchDockerToken(request, url, tokenRegistry, scopeRequests);
  }

  if (context.repository) {
    const denied = assertRepositoryAllowed(context.repository, context.registry, env);
    if (denied) {
      return denied;
    }
  }

  const acceleratorResult = await fetchDockerAccelerators(request, url, context, env);
  if (acceleratorResult.response) {
    return acceleratorResult.response;
  }

  const upstreamUrl = new URL(getUpstreamSearch(url), `https://${context.registry.host}`);
  upstreamUrl.pathname = context.upstreamPath;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildDockerHeaders(request, context.registry.host),
    body: requestBody(request),
    redirect: "manual",
  });
  const fallback = {
    fallbackReason: acceleratorResult.fallbackReason,
  };
  if (acceleratorResult.attempts.length > 0) {
    fallback.acceleratorAttempts = acceleratorResult.attempts;
  }
  logDockerUpstream(request, context, "origin", context.registry.host, upstreamResponse.status, fallback);

  const headers = copyProxyHeaders(upstreamResponse.headers);
  const authenticate = headers.get("Www-Authenticate");
  if (authenticate) {
    headers.set("Www-Authenticate", rewriteAuthenticateHeader(authenticate, url.origin, context.registry));
  }

  const location = headers.get("Location");
  if (location) {
    return proxyDockerRedirect(request, location, context.registry);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
}
