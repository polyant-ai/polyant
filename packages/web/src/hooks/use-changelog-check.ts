// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

import type { ChangelogData, ChangelogEntry } from "@/lib/changelog-types";
import { extractUnseenChangelogs } from "@/lib/version-compare";
import { isPlatformAdminRole } from "@/lib/user-role";

const STORAGE_KEY = "polyant-last-seen-version";

interface UseChangelogCheckReturn {
  version: string;
  newVersionAvailable: boolean;
  unseenChangelogs: ChangelogEntry[];
  markAsSeen: () => void;
}

/**
 * Fetches the build-time /changelog.json once, and — for a Platform Admin
 * only, per design decision — compares it against localStorage to surface
 * changelog entries the operator has not seen yet.
 */
export function useChangelogCheck(): UseChangelogCheckReturn {
  const { data: session } = useSession();
  const canViewChangelog = isPlatformAdminRole(session?.user?.role);

  const [data, setData] = useState<ChangelogData | null>(null);
  const [unseenChangelogs, setUnseenChangelogs] = useState<ChangelogEntry[]>([]);
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);

  useEffect(() => {
    fetch("/changelog.json")
      .then((res) => res.json() as Promise<ChangelogData>)
      .then((changelogData) => {
        setData(changelogData);

        if (!canViewChangelog) return;

        const lastSeenVersion = localStorage.getItem(STORAGE_KEY);
        const unseen = extractUnseenChangelogs(lastSeenVersion, changelogData.version, changelogData.changelog);
        setUnseenChangelogs(unseen);
        setNewVersionAvailable(unseen.length > 0);
      })
      .catch((err) => {
        console.error("Failed to fetch changelog.json:", err);
      });
  }, [canViewChangelog]);

  const markAsSeen = () => {
    if (data) localStorage.setItem(STORAGE_KEY, data.version);
    setNewVersionAvailable(false);
  };

  return {
    version: data?.version ?? "",
    newVersionAvailable: canViewChangelog && newVersionAvailable,
    unseenChangelogs: canViewChangelog ? unseenChangelogs : [],
    markAsSeen,
  };
}
