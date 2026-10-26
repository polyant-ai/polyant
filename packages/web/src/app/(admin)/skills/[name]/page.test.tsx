// SPDX-License-Identifier: AGPL-3.0-or-later

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import SkillRedirectPage from "./page";

describe("skill detail route", () => {
  // The skill used to live on this page. A link saved before the drawer existed
  // must still land on that skill, not on a blank page or a 404.
  it("sends an old /skills/<slug> link to the catalog with that skill open", async () => {
    await SkillRedirectPage({ params: Promise.resolve({ name: "web-research" }) });
    expect(redirect).toHaveBeenCalledWith("/skills?skill=web-research");
  });

  it("keeps a slug with unusual characters intact in the query", async () => {
    await SkillRedirectPage({ params: Promise.resolve({ name: "a b&c" }) });
    expect(redirect).toHaveBeenLastCalledWith("/skills?skill=a%20b%26c");
  });
});
