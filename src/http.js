export function textResponse(body, status = 200, headers = {}) {
  const nextHeaders = new Headers(headers);
  if (!nextHeaders.has("Content-Type")) {
    nextHeaders.set("Content-Type", "text/plain; charset=UTF-8");
  }
  return new Response(body, { status, headers: nextHeaders });
}

export function htmlResponse(body) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
    },
  });
}

export function corsPreflight(request) {
  if (request.method.toUpperCase() !== "OPTIONS") {
    return null;
  }

  if (!request.headers.has("Access-Control-Request-Headers")) {
    return null;
  }

  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers"),
      "Access-Control-Max-Age": "1728000",
    },
  });
}

export function copyProxyHeaders(headers) {
  const nextHeaders = new Headers(headers);
  nextHeaders.set("Access-Control-Allow-Origin", "*");
  nextHeaders.set("Access-Control-Expose-Headers", "*");
  nextHeaders.delete("Content-Security-Policy");
  nextHeaders.delete("Content-Security-Policy-Report-Only");
  nextHeaders.delete("Clear-Site-Data");
  return nextHeaders;
}

export function commaList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function requestBody(request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return null;
  }

  return request.body;
}

export function isAllowed(value, patterns) {
  const normalized = value.toLowerCase();
  return patterns.some((pattern) => {
    const item = pattern.toLowerCase();
    if (item === normalized) {
      return true;
    }

    if (item.endsWith("/*")) {
      return normalized.startsWith(item.slice(0, -1));
    }

    return false;
  });
}
