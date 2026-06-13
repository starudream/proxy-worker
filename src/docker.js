import { DOCKER } from "./config";
import { commaList, copyProxyHeaders, corsPreflight, isAllowed, requestBody, textResponse } from "./http";

const DOCKER_HUB_REGISTRY = "docker.io";

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
  if (registry.authHost) {
    return `https://${registry.authHost}/token`;
  }

  return `https://${registry.host}/token`;
}

function getRegistryService(registry) {
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

  const upstreamUrl = new URL(getUpstreamSearch(url), `https://${context.registry.host}`);
  upstreamUrl.pathname = context.upstreamPath;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildDockerHeaders(request, context.registry.host),
    body: requestBody(request),
    redirect: "manual",
  });

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
