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
      registry: defaultRegistry(),
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

function getRepositoriesFromScopes(scopes, registry) {
  return scopes
    .map((scope) => /^repository:([^:]+):/.exec(scope))
    .filter(Boolean)
    .map((match) => normalizeRepositoryForRegistry(match[1], registry));
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

function getTokenUrl(url, registry) {
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
    tokenUrl.searchParams.append(key, value);
  }
  return tokenUrl;
}

async function fetchDockerToken(request, url, registry) {
  const tokenUrl = getTokenUrl(url, registry);
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

export async function handleDocker(request, env) {
  const preflight = corsPreflight(request);
  if (preflight) {
    return preflight;
  }

  const url = new URL(request.url);
  const context = getDockerContext(url);

  if (!context || !context.registry) {
    return textResponse("invalid docker upstream", 400);
  }

  if (context.upstreamPath === "/token") {
    const scopes = getTokenScopes(url);
    const repositories = getRepositoriesFromScopes(scopes, context.registry);
    if (repositories.length !== scopes.length) {
      return textResponse("forbidden", 403);
    }

    for (const repository of repositories) {
      const denied = assertRepositoryAllowed(repository, context.registry, env);
      if (denied) {
        return denied;
      }
    }

    return fetchDockerToken(request, url, context.registry);
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
