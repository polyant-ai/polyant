// SPDX-License-Identifier: AGPL-3.0-or-later

import { redirect } from "next/navigation";

/**
 * A skill no longer has a page of its own: the catalog opens it in a drawer.
 * Existing links to `/skills/<slug>` land on the catalog with that skill open.
 */
export default async function SkillRedirectPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(`/skills?skill=${encodeURIComponent(name)}`);
}
