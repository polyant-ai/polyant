// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, getUserErrorMessage, type SecretStatus } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

export interface InstanceSecret {
  /** The pending value. Empty means "no new value typed", NOT "cleared". */
  value: string;
  setValue: (value: string) => void;
  visible: boolean;
  toggleVisibility: () => void;
  /** The agent holds this key itself. */
  configured: boolean;
  /** A new value is typed and differs from what is stored. */
  dirty: boolean;
  loading: boolean;
  /** Writes the pending value. A no-op when nothing is pending. */
  save: () => Promise<void>;
  /** Deletes the agent's own key. */
  remove: () => Promise<void>;
}

/**
 * One agent credential, with everything a caller needs to render and write it.
 *
 * Extracted so a credential can live NEXT TO the thing it authenticates rather
 * than in the model settings: the LangSmith key belongs with the LangSmith switch,
 * the inbound API key with the channel it lets callers reach. Before this, that
 * state was entangled in one 1500-line form's `secretFields` map, so moving a
 * single field meant copying the machine.
 *
 * A credential here is the AGENT's, full stop. Enterprise adds a second source —
 * an organization's shared keys, which the engine falls back to — and there the
 * hook carries a separate `inherited` fact beside `configured`, because
 * collapsing the two would report "not configured" about a credential that is
 * working. There is no organization-level secret store in this build, so the
 * fact does not exist and `SecretField`'s `inherited` prop is simply never passed.
 */
export function useInstanceSecret(slug: string, key: string): InstanceSecret {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  // What is stored, as far as this hook knows — the baseline `dirty` compares
  // against, refreshed after a write so a second edit is measured from the last
  // save rather than from page load.
  const [stored, setStored] = useState("");
  const [visible, setVisible] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Degrades rather than throws: reading secrets is admin-and-above, and a
      // member must still see the switch beside the field.
      const own = await Promise.allSettled([api.secrets.list(slug)]);
      if (cancelled) return;

      const ownSecrets: SecretStatus[] =
        own[0].status === "fulfilled" ? own[0].value.secrets : [];

      setConfigured(ownSecrets.some((s) => s.key === key && s.configured));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, key]);

  // Empty is "nothing typed", not "clear it" — clearing is `remove`, which is a
  // deliberate, confirmed action rather than a blank field slipping through a save.
  const dirty = value !== "" && value !== stored;

  const save = useCallback(async () => {
    if (value === "" || value === stored) return;
    await api.secrets.set(slug, [{ key, value }]);
    setStored(value);
    setConfigured(true);
  }, [slug, key, value, stored]);

  const remove = useCallback(async () => {
    try {
      await api.secrets.delete(slug, key);
      setConfigured(false);
      setValue("");
      setStored("");
      toast.success(t("common.deleted"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    }
  }, [slug, key, t]);

  return {
    value,
    setValue,
    visible,
    toggleVisibility: () => setVisible((v) => !v),
    configured,
    dirty,
    loading,
    save,
    remove,
  };
}
