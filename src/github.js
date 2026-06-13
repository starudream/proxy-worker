import { GITHUB } from "./config";
import { commaList, corsPreflight, isAllowed, requestBody, textResponse } from "./http";

function normalizeGitHubTarget(target) {
  if (/^https:\/github\.com\//i.test(target)) {
    return target.replace(/^https:\//i, "https://");
  }

  if (/^[^/]+\/[^/]+\/(releases|archive|raw)\//i.test(target)) {
    return `https://github.com/${target}`;
  }

  return target;
}

function getGitHubTarget(url) {
  if (url.pathname.startsWith("/github/")) {
    return normalizeGitHubTarget(url.pathname.slice("/github/".length) + url.search);
  }

  return normalizeGitHubTarget(url.href.slice(url.origin.length + 1));
}

function getAllowList(env) {
  return {
    owners: [
      ...GITHUB.owners,
      ...commaList(env.GITHUB_OWNER_ALLOWLIST),
    ],
    repositories: [
      ...GITHUB.repositories,
      ...commaList(env.GITHUB_REPO_ALLOWLIST),
    ],
  };
}

function buildGitHubHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("Host");
  return headers;
}

export function isGitHubRequest(url) {
  if (url.pathname.startsWith("/github/")) {
    return true;
  }

  const target = normalizeGitHubTarget(url.href.slice(url.origin.length + 1));
  return /^https:\/\/github\.com\//i.test(target) || /^[^/]+\/[^/]+\/(releases|archive|raw)\//i.test(target);
}

export async function handleGitHub(request, env) {
  const preflight = corsPreflight(request);
  if (preflight) {
    return preflight;
  }

  const url = new URL(request.url);
  const target = getGitHubTarget(url);
  const matches = GITHUB.pathPattern.exec(target);

  if (!matches) {
    return textResponse("invalid", 400);
  }

  const owner = matches[1];
  const repo = matches[2];
  const fullRepo = `${owner}/${repo}`;
  const allowList = getAllowList(env);

  if (!isAllowed(owner, allowList.owners) && !isAllowed(fullRepo, allowList.repositories)) {
    return textResponse("forbidden", 403);
  }

  const upstreamResponse = await fetch(target, {
    method: request.method,
    headers: buildGitHubHeaders(request),
    body: requestBody(request),
    redirect: "follow",
  });

  const headers = new Headers(upstreamResponse.headers);
  headers.set("X-Proxy-Redirect", upstreamResponse.url);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
}
