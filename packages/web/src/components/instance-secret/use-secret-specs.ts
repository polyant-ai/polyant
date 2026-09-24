// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, getUserErrorMessage, isForbidden, type RequiredSecretSpec } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

function withoutKey(record: Record<string, string>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

export interface SecretSpecsForm {
  loading: boolean;
  /** False when the caller may not read this agent's secrets (member, viewer). */
  canRead: boolean;
  /** The agent holds this key itself. */
  isConfigured: (key: string) => boolean;
  value: (key: string) => string;
  setValue: (key: string, value: string) => void;
  visible: (key: string) => boolean;
  toggleVisibility: (key: string) => void;
  /** At least one field holds a typed value that differs from what is stored. */
  dirty: boolean;
  /** Writes every pending value. A no-op when nothing is pending. */
  save: () => Promise<void>;
  /** Deletes one of the agent's own keys. */
  remove: (key: string) => Promise<void>;
  /** Drops every typed value, back to what is stored. */
  reset: () => void;
}

/**
 * The declared fields of an agent's tools and hooks, as one form: which keys are
 * stored, what has been typed, and the write.
 *
 * `useInstanceSecret` owns ONE credential; this is the same machine for the set
 * a page renders from `requiredSecrets` declarations. The values shown for
 * non-sensitive fields come from `GET /tools/required-secrets`, the only
 * endpoint that echoes them; sensitive ones are never echoed and start empty.
 *
 * Empty is "nothing typed", not "clear it": clearing is `remove`, a confirmed
 * action, so a blank field can never slip a deletion through a save.
 *
 * `specs` is only read for which fields are cleartext: after a save those keep
 * their new value on screen, while a masked one goes back to empty — the value
 * never lingers in an input once it is stored.
 */
export function useSecretSpecs(slug: string, specs: readonly RequiredSecretSpec[]): SecretSpecsForm {
  const { t } = useI18n();
  const readable = useMemo(
    () => new Set(specs.filter((s) => s.sensitive === false || s.type === "select").map((s) => s.key)),
    [specs],
  );
  const [loading, setLoading] = useState(true);
  const [canRead, setCanRead] = useState(true);
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
  /** The stored cleartext of non-sensitive fields: the baseline `dirty` compares against. */
  const [stored, setStored] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.secrets.list(slug), api.tools.requiredSecrets(slug)]).then(
      ([secretsRes, specsRes]) => {
        if (cancelled) return;
        if (secretsRes.status === "fulfilled") {
          setConfigured(new Set(secretsRes.value.secrets.filter((s) => s.configured).map((s) => s.key)));
        } else {
          // Reading secrets is admin-and-above: a member still sees what a tool
          // asks for, just not whether it is set.
          setCanRead(false);
          if (!isForbidden(secretsRes.reason)) toast.error(t("settings.tab.loadFailed"));
        }
        if (specsRes.status === "fulfilled") {
          setStored(
            Object.fromEntries(
              specsRes.value.requiredSecrets
                .filter((s) => s.currentValue !== undefined)
                .map((s) => [s.key, s.currentValue as string]),
            ),
          );
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // `t` is left out on purpose, as in the settings form: the load is keyed on
    // the agent, and a locale switch must not refetch its secrets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const pending = useMemo(
    () => Object.entries(typed).filter(([key, v]) => v !== "" && v !== (stored[key] ?? "")),
    [typed, stored],
  );

  const save = useCallback(async () => {
    if (pending.length === 0) return;
    const res = await api.secrets.set(
      slug,
      pending.map(([key, value]) => ({ key, value })),
    );
    setConfigured(new Set(res.secrets.filter((s) => s.configured).map((s) => s.key)));
    setStored((prev) => ({ ...prev, ...Object.fromEntries(pending.filter(([key]) => readable.has(key))) }));
    setTyped({});
  }, [slug, pending, readable]);

  const remove = useCallback(
    async (key: string) => {
      try {
        await api.secrets.delete(slug, key);
        setConfigured((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setStored((prev) => withoutKey(prev, key));
        setTyped((prev) => withoutKey(prev, key));
        toast.success(t("common.deleted"));
      } catch (err) {
        toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug],
  );

  return {
    loading,
    canRead,
    isConfigured: (key) => configured.has(key),
    value: (key) => typed[key] ?? stored[key] ?? "",
    setValue: (key, value) => setTyped((prev) => ({ ...prev, [key]: value })),
    visible: (key) => shown.has(key),
    toggleVisibility: (key) =>
      setShown((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    dirty: pending.length > 0,
    save,
    remove,
    reset: () => setTyped({}),
  };
}
