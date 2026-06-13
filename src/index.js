import { HOME_HTML } from "./config";
import { handleDocker, isDockerRequest } from "./docker";
import { handleGitHub, isGitHubRequest } from "./github";
import { htmlResponse, textResponse } from "./http";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return htmlResponse(HOME_HTML);
    }

    if (isGitHubRequest(url)) {
      return handleGitHub(request, env);
    }

    if (isDockerRequest(url)) {
      return handleDocker(request, env);
    }

    return textResponse("not found", 404);
  },
};
