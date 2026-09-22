// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { projectEventPayload } from "./payload-projection.js";

// A GitHub issues payload, trimmed to the shape that matters: every object
// carries API URL templates and node ids, and no interpretation prompt can act
// on them.
const GITHUB_PAYLOAD = {
  action: "opened",
  issue: {
    number: 381,
    title: "Room re-sends the whole raw webhook payload",
    body: "measured on one real event",
    state: "open",
    created_at: "2026-09-21T10:00:00Z",
    url: "https://api.github.com/repos/acme/app/issues/381",
    html_url: "https://github.com/acme/app/issues/381",
    comments_url: "https://api.github.com/repos/acme/app/issues/381/comments",
    node_id: "I_kwDO",
    labels: [{ name: "bug", node_id: "LA_kw", url: "https://api.github.com/repos/acme/app/labels/bug" }],
    user: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1", gravatar_id: "" },
  },
  repository: {
    full_name: "acme/app",
    default_branch: "main",
    stargazers_url: "https://api.github.com/repos/acme/app/stargazers",
    notifications_url: "https://api.github.com/repos/acme/app/notifications{?since}",
    html_url: "https://github.com/acme/app",
  },
  sender: { login: "octocat", node_id: "MDQ6", followers_url: "https://api.github.com/users/octocat/followers" },
};

describe("projectEventPayload", () => {
  it("drops the URL templates and ids, keeps what a prompt can act on", () => {
    // Timestamps stay: they carry ordering and are how an agent recognises a
    // replay. `html_url` stays: it is the one URL an agent writes into a reply.
    expect(projectEventPayload("github", GITHUB_PAYLOAD)).toEqual({
      action: "opened",
      issue: {
        number: 381,
        title: "Room re-sends the whole raw webhook payload",
        body: "measured on one real event",
        state: "open",
        created_at: "2026-09-21T10:00:00Z",
        html_url: "https://github.com/acme/app/issues/381",
        labels: [{ name: "bug" }],
        user: { login: "octocat" },
      },
      repository: {
        full_name: "acme/app",
        default_branch: "main",
        html_url: "https://github.com/acme/app",
      },
      sender: { login: "octocat" },
    });
  });

  it("leaves an unknown source type untouched", () => {
    const hubspot = { objectId: 42, propertyName: "dealstage", portal_url: "https://app.hubspot.com/x" };

    expect(projectEventPayload("hubspot", hubspot)).toEqual(hubspot);
    expect(projectEventPayload(undefined, hubspot)).toEqual(hubspot);
  });

  it("matches the source type regardless of case or padding", () => {
    expect(projectEventPayload(" GitHub ", { sender: { login: "a", node_id: "b" } })).toEqual({
      sender: { login: "a" },
    });
  });

  it("does not mutate the payload it was given", () => {
    const payload = { sender: { login: "octocat", node_id: "MDQ6" } };

    projectEventPayload("github", payload);

    expect(payload.sender.node_id).toBe("MDQ6");
  });
});
