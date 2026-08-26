// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Trash2, AlertTriangle, Info, Search, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, getUserErrorMessage, isForbidden, type Instance, type SecretStatus, type ModelsResponse, type RequiredSecretSpec } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { SecretField, SecretStatusBadge } from "@/components/instance-secret/secret-field";
import type { TranslationKey } from "@/lib/i18n/types";
import {
  PROVIDER_CREDENTIAL_KEYS,
  PROVIDER_SECRET_SECTIONS,
  SECRET_KEYS,
  type ProviderSectionId,
} from "@/lib/provider-secrets";
import { usePageSaveAction } from "./page-actions-context";

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
  /**
   * Which half of this form to render.
   *
   * Four pages come out of this one component, because they all need the same
   * loaded secrets, the same required-secret specs and the same `secretFields`
   * machine:
   *
   *   `model`       — which model runs the agent, the embedder, speech-to-text,
   *                   prompt caching, temperature.
   *   `credentials` — the PROVIDER keys. Their own page because a key used to be
   *                   reachable from three places, and "where do I put an API key"
   *                   must have one answer.
   *   `toolSecrets` — the keys the enabled tools and hooks demand. Beside the tool
   *                   list rather than with the provider keys: they exist because a
   *                   tool asked for them, and they are read while deciding what the
   *                   agent may do.
   *   `params`      — what the engine puts in front of the model each turn. Rendered
   *                   inside the Parametri page, next to memory and diagnostics.
   *
   * Only one is mounted at a time, so each writes only its own fields: a save from
   * one page can never carry a stale copy of another's.
   */
  section: "model" | "credentials" | "toolSecrets" | "params";
}

const SECRET_KEYS = {
  OPENAI: "openai_api_key",
  ANTHROPIC: "anthropic_api_key",
  NEBIUS: "nebius_api_key",
  BEDROCK_API_KEY: "bedrock_api_key",
  // AWS credentials for the AI provider (Bedrock chat + embedder, Transcribe STT).
  // Dedicated namespace — independent of the generic aws_* keys used by tools.
  AWS_PROVIDER_ACCESS_KEY_ID: "aws_provider_access_key_id",
  AWS_PROVIDER_SECRET_ACCESS_KEY: "aws_provider_secret_access_key",
  AWS_PROVIDER_REGION: "aws_provider_region",
  LANGSMITH: "langsmith_api_key",
  AUTH: "auth_api_key",
  DEEPGRAM: "deepgram_api_key",
} as const;

type STTProvider = "openai" | "aws" | "deepgram" | "disabled";

const BRAND_NAMES: Record<string, string> = {
  hubspot: "HubSpot",
  openai: "OpenAI",
  anthropic: "Anthropic",
  nebius: "Nebius",
  bedrock: "AWS Bedrock",
  aws: "AWS",
  tavily: "Tavily",
  langsmith: "LangSmith",
};

// Display labels for reasoning-effort levels (values come from the model's
// live-verified reasoningLevels set exposed by /api/instances/models).
const REASONING_LEVEL_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// Model-catalog dialog: a flattened row (model + its provider) and the
// column keys the table can sort by.
type CatalogRow = ModelsResponse["providers"][string]["models"][number] & { provider: string };
type CatalogSortKey = "provider" | "model" | "input" | "output" | "cacheRead" | "cacheWrite";

function catalogSortValue(row: CatalogRow, key: CatalogSortKey): string | number {
  switch (key) {
    case "provider":
      return BRAND_NAMES[row.provider] ?? row.provider;
    case "model":
      return row.id;
    case "input":
      return row.costInput;
    case "output":
      return row.costOutput;
    case "cacheRead":
      return row.costCacheRead;
    case "cacheWrite":
      return row.costCacheWrite;
  }
}

function humanizeSecretKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => {
      const lower = w.toLowerCase();
      if (lower === "api") return "API";
      if (lower === "key") return "Key";
      return BRAND_NAMES[lower] ?? w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export function SettingsTab({ instance, onUpdate, section }: Props) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  // `agent.secret:read` is MEMBER+ now (a member configures an agent end to end,
  // credentials included — docs/rbac-permission-matrix.md), so only a viewer gets a
  // 403 on secrets.list. Hide the provider-secret UI for them instead of surfacing
  // a misleading error.
  //
  // Derived from the engine's actual answer rather than from a client-side
  // permission check, deliberately: one source (the 403) cannot disagree with
  // enforcement the way a second, hand-maintained gate could.
  const [canReadSecrets, setCanReadSecrets] = useState(true);
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // AI Model settings
  const [provider, setProvider] = useState(instance.provider ?? "");
  const [model, setModel] = useState(instance.model ?? "");
  // Embedder provider — chosen INDEPENDENTLY of the chat LLM. Only OpenAI and
  // Bedrock embed (Anthropic has no embeddings API). Changing it wipes memories
  // + knowledge (vectors are provider-specific), hence the confirmation below.
  const [embeddingProvider, setEmbeddingProvider] = useState<"openai" | "bedrock">(
    (instance.embeddingProvider as "openai" | "bedrock" | undefined) ?? "openai",
  );
  // Persisted user preference; the toggle below is hidden when the selected
  // model is not thinking-capable, but the state is preserved so that
  // switching back to a capable model reapplies the preference.
  const [thinkingEnabled, setThinkingEnabled] = useState(instance.thinkingEnabled);
  // Reasoning intensity when thinking is on. Applied only by Nebius for now
  // (maps to reasoning_effort). Portable set: low|medium|high.
  const [thinkingLevel, setThinkingLevel] = useState<string>(instance.thinkingLevel ?? "medium");

  // Sampling temperature (0–2). Null means "use the engine default". Disabled
  // when the selected model does not support temperature (e.g. reasoning models).
  const [temperature, setTemperature] = useState<number | null>(instance.temperature ?? null);

  // Conversation state store: render known state read-only into the prompt (default off).
  const [stateInPromptEnabled, setStateInPromptEnabled] = useState(instance.stateInPromptEnabled);

  // Inject the current date/time into every turn (default on).
  const [datetimeInjectionEnabled, setDatetimeInjectionEnabled] = useState(instance.datetimeInjectionEnabled);

  // Prompt-cache control (default on, 1h). OpenAI = automatic (locked on); Nebius = none.
  const [cacheEnabled, setCacheEnabled] = useState(instance.cacheEnabled);
  const [cacheTtl, setCacheTtl] = useState(instance.cacheTtl);

  // Replay prior-turn tool results into the model's cross-turn history (default off).
  const [toolResultsInHistoryEnabled, setToolResultsInHistoryEnabled] = useState(
    instance.toolResultsInHistoryEnabled,
  );

  // DEBUG mode: persist the exact LLM request payload per turn (default off).
  const [debugEnabled, setDebugEnabled] = useState(instance.debugEnabled ?? false);

  // Memory

  // Knowledge

  // Required-secret specs (tools + hooks, dynamic, from API). Each entry describes
  // how to render and persist the field (text input vs select dropdown).
  const [requiredSecretSpecs, setRequiredSecretSpecs] = useState<RequiredSecretSpec[]>([]);

  // What the tools' own block renders: the required specs minus the provider
  // credentials, which have their own blocks above (see PROVIDER_CREDENTIAL_KEYS).
  const toolSecretSpecs = requiredSecretSpecs.filter(
    (spec) => !PROVIDER_CREDENTIAL_KEYS.has(spec.key),
  );

  // Secret input values, visibility toggles, and original value (for dirty tracking).
  // `initial` is the server-side value at load time (only populated for non-secret select fields).
  const [secretFields, setSecretFields] = useState<Record<string, { value: string; initial: string; visible: boolean }>>(
    () => Object.fromEntries(
      Object.values(SECRET_KEYS).map((key) => [key, { value: "", initial: "", visible: false }]),
    ),
  );

  const secretValue = (key: string) => secretFields[key]?.value ?? "";
  const secretVisible = (key: string) => secretFields[key]?.visible ?? false;
  const setSecretValue = (key: string, value: string) =>
    setSecretFields((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
  const toggleSecretVisibility = (key: string) =>
    setSecretFields((prev) => ({ ...prev, [key]: { ...prev[key], visible: !prev[key].visible } }));
  const clearAllSecretValues = () =>
    setSecretFields((prev) =>
      Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, value: v.initial }])),
    );

  // Model catalog dialog: search + provider filter + column sort over a single
  // flattened table (was one table per provider, which overflowed).
  const [pricingOpen, setPricingOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogProvider, setCatalogProvider] = useState("all");
  const [catalogSort, setCatalogSort] = useState<{ key: CatalogSortKey; dir: "asc" | "desc" }>({
    key: "provider",
    dir: "asc",
  });

  // Destructive-wipe dialog: shown when the chosen EMBEDDER changes (openai↔bedrock).
  // Existing embeddings live in a provider-specific space and are NOT converted —
  // memories + knowledge are permanently deleted. Changing the chat LLM is unaffected.
  const [wipeOpen, setWipeOpen] = useState(false);


  // `authEnabled` is NOT here any more: it gates the HTTP surface, so it lives with
  // the Web/API channel, beside the key that satisfies it.

  // Audio (STT)
  const [sttProvider, setSttProvider] = useState<STTProvider>(
    (instance.sttProvider as STTProvider | null) ?? "openai",
  );

  useEffect(() => {
    let cancelled = false;
    // Decoupled: a member can read models/tools but not secrets. Loading them
    // atomically let an admin-only secrets 403 blank the whole tab (incl. the
    // provider/model selectors the member IS allowed to use). allSettled keeps
    // each independent.
    Promise.allSettled([
      api.secrets.list(instance.slug),
      api.models.list(),
      api.tools.requiredSecrets(instance.slug),
    ]).then(([secretsRes, modelsRes, toolSecretsRes]) => {
      if (cancelled) return;
      if (modelsRes.status === "fulfilled") setModelsData(modelsRes.value);
      else toast.error(t("settings.tab.loadFailed"));

      if (toolSecretsRes.status === "fulfilled") {
        setRequiredSecretSpecs(toolSecretsRes.value.requiredSecrets);
      }

      if (secretsRes.status === "fulfilled") {
        setSecrets(secretsRes.value.secrets);
      } else if (isForbidden(secretsRes.reason)) {
        setCanReadSecrets(false); // expected for member/viewer — degrade silently
      } else {
        toast.error(t("settings.tab.loadFailed"));
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [instance.slug]);

  useEffect(() => {
    setSecretFields((prev) => {
      const next = { ...prev };
      for (const spec of requiredSecretSpecs) {
        if (!(spec.key in next)) {
          // Pre-fill any non-sensitive field (select or readable text) from its
          // echoed `currentValue`. Sensitive fields never carry one, so they
          // initialize to empty.
          const initialValue = spec.currentValue ?? "";
          next[spec.key] = { value: initialValue, initial: initialValue, visible: false };
        }
      }
      return next;
    });
  }, [requiredSecretSpecs]);

  const isConfigured = (key: string) =>
    secrets.some((s) => s.key === key && s.configured);


  // The client-side "is the embedder configured" rule used to live here, unused
  // since the knowledge switch moved to its own tab. It is gone: the engine reports
  // it on `instance.embedder`, which the Knowledge tab reads. Recomputing it in the
  // browser was also subtly wrong — the client cannot see the engine's AWS_REGION
  // fallback.

  /*
    Which provider sections Credenziali renders: EVERY one of them, whatever this
    agent currently runs on.

    It used to render only the providers already selected for chat, the embedder
    or STT. That made the page describe the current choice rather than hold the
    credentials, and it inverted the order of two steps an operator does in the
    other order: a key could not be entered until the agent had already been
    pointed at the provider it belongs to, so preparing an agent for Bedrock
    before switching it to Bedrock was impossible, and the switch had to be saved
    against a provider with no credentials.

    `langsmith` stays out, and this is the one exception left: its key is rendered
    by `langsmith-card.tsx` beside the switch that turns tracing on, with its own
    save. That is a placement decision, not a gate — the key is always reachable
    there, which is what this rule is about.
  */
  const providerSectionIsCredential = (id: ProviderSectionId) => id !== "langsmith";

  const providerNames = modelsData ? Object.keys(modelsData.providers) : [];

  // Flatten → filter (search + provider) → sort for the catalog table.
  const catalogRows = useMemo<CatalogRow[]>(() => {
    if (!modelsData) return [];
    const flat: CatalogRow[] = Object.entries(modelsData.providers).flatMap(
      ([providerName, { models }]) => models.map((m) => ({ ...m, provider: providerName })),
    );
    const q = catalogSearch.trim().toLowerCase();
    const filtered = flat.filter(
      (m) =>
        (catalogProvider === "all" || m.provider === catalogProvider) &&
        (q === "" ||
          m.id.toLowerCase().includes(q) ||
          (m.tier ?? "").toLowerCase().includes(q) ||
          (BRAND_NAMES[m.provider] ?? m.provider).toLowerCase().includes(q)),
    );
    const dir = catalogSort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = catalogSortValue(a, catalogSort.key);
      const bv = catalogSortValue(b, catalogSort.key);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [modelsData, catalogSearch, catalogProvider, catalogSort]);

  const toggleCatalogSort = (key: CatalogSortKey) =>
    setCatalogSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "provider" || key === "model" ? "asc" : "desc" },
    );

  // Sortable column header: label + direction arrow, toggles sort on click.
  const catalogSortHead = (
    labelKey: TranslationKey,
    key: CatalogSortKey,
    opts?: { width?: string; right?: boolean },
  ) => {
    const active = catalogSort.key === key;
    const Arrow = active ? (catalogSort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
    // whitespace-normal so long labels (e.g. "Cache scrittura") wrap inside the
    // fixed column instead of overflowing into the next one; the button is w-full
    // so the flex constrains the label to the cell width.
    return (
      <TableHead className={cn("align-bottom whitespace-normal", opts?.width, opts?.right && "text-right")}>
        <button
          type="button"
          onClick={() => toggleCatalogSort(key)}
          className={cn(
            "flex w-full items-center gap-1 hover:text-foreground",
            opts?.right ? "justify-end" : "justify-start",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span>{t(labelKey)}</span>
          <Arrow className={cn("h-3 w-3 shrink-0", !active && "opacity-40")} />
        </button>
      </TableHead>
    );
  };
  const availableModels = provider && modelsData?.providers[provider]
    ? modelsData.providers[provider].models
    : [];
  // When no model is pinned ("System default"), mirror the backend's
  // effectiveModelFor fallback and resolve capabilities from the standard-tier
  // model — otherwise thinking/temperature stay disabled for default instances.
  const selectedModelInfo =
    availableModels.find((m) => m.id === model) ??
    (model === "" ? availableModels.find((m) => m.tier === "standard") : undefined);
  // Show the "Extended thinking" toggle only when the chosen model supports it.
  // The capability flag is computed server-side (single source of truth in
  // ai-gateway/config.ts), so the UI cannot drift from runtime behaviour.
  const canEnableThinking = !!selectedModelInfo?.supportsThinking;
  // gpt-oss & co. reason on EVERY call — there is no off, only an effort level.
  // The toggle is locked ON for these models; we also persist it ON so the
  // backend applies the effort (a stale `false` would make it skip
  // reasoning_effort and silently fall back to the model default).
  const alwaysOnThinking = !!selectedModelInfo?.reasoningAlwaysOn;
  const thinkingToPersist = alwaysOnThinking || thinkingEnabled;

  // Effective thinking mirrors the engine's runtime gate (config-resolver.ts):
  // a stale `thinkingEnabled=true` persisted for a now-non-capable model has no
  // effect. Without this gate the temperature field stays wrongly locked (and
  // its hidden toggle is unreachable) after switching to a non-thinking model.
  const effectiveThinkingEnabled = thinkingToPersist && canEnableThinking;

  // Temperature control availability. Under extended thinking most models ignore or
  // reject a custom temperature (Anthropic forces temp=1, OpenAI 1P 400s), but
  // open-weight/vLLM reasoners (gpt-oss, Bedrock MiniMax, Nebius) accept both — gated
  // per-model by supportsTemperatureWithThinking. Thinking off: the plain gate.
  const canSetTemperature = effectiveThinkingEnabled
    ? !!selectedModelInfo?.supportsTemperatureWithThinking
    : !!selectedModelInfo?.supportsTemperature;

  // Reset model when provider changes
  const handleProviderChange = (value: string) => {
    setProvider(value);
    setModel("");
  };

  // Per-section, so the Save button of one half never lights up for an edit made in
  // the other — and, more importantly, so its payload carries only its own fields.
  const modelDirty =
    provider !== (instance.provider ?? "") ||
    model !== (instance.model ?? "") ||
    embeddingProvider !== ((instance.embeddingProvider as "openai" | "bedrock" | undefined) ?? "openai") ||
    thinkingToPersist !== instance.thinkingEnabled ||
    thinkingLevel !== (instance.thinkingLevel ?? "medium") ||
    temperature !== (instance.temperature ?? null) ||
    cacheEnabled !== instance.cacheEnabled ||
    cacheTtl !== instance.cacheTtl ||
    sttProvider !== ((instance.sttProvider as STTProvider | null) ?? "openai");

  const paramsDirty =
    stateInPromptEnabled !== instance.stateInPromptEnabled ||
    datetimeInjectionEnabled !== instance.datetimeInjectionEnabled ||
    toolResultsInHistoryEnabled !== instance.toolResultsInHistoryEnabled ||
    debugEnabled !== (instance.debugEnabled ?? false);

  // The two secret pages are dirty on their fields; the two settings pages on
  // theirs. Nothing overlaps, so no page can save another's values.
  const secretsDirty = Object.values(secretFields).some((f) => f.value !== f.initial);
  const isDirty =
    section === "credentials" || section === "toolSecrets"
      ? secretsDirty
      : section === "model"
        ? modelDirty
        : paramsDirty;

  const performSave = async (confirmWipe: boolean) => {
    setSaving(true);
    try {
      // 1. Save secrets (only fields whose value diverges from the loaded baseline).
      // This covers both newly entered API keys (initial="" → value="sk-...") and
      // changed select dropdowns (initial="tavily" → value="serpapi").
      const secretsToSave = Object.entries(secretFields)
        .filter(([, f]) => f.value !== "" && f.value !== f.initial)
        .map(([key, f]) => ({ key, value: f.value }));

      if (secretsToSave.length > 0) {
        const res = await api.secrets.set(instance.slug, secretsToSave);
        setSecrets(res.secrets);
        // Refresh the initial baseline so subsequent edits compute dirty against
        // the just-saved values, not the pre-save baseline.
        setSecretFields((prev) => {
          const next = { ...prev };
          for (const { key, value } of secretsToSave) {
            if (next[key]) next[key] = { ...next[key], initial: value };
          }
          return next;
        });
      }

      // 2. Save instance-level settings — the two secret pages have none, so they
      // stop here rather than sending an update the engine would apply to nothing.
      // `confirmWipe` acknowledges that an embedding-provider change permanently
      // deletes memories + knowledge; the engine rejects the switch without it when
      // there is data to lose.
      if (section === "model" || section === "params") {
        const { instance: updated } = await api.instances.update(
          instance.slug,
          section === "model"
            ? {
                provider: provider || null,
                model: model || null,
                embeddingProvider,
                thinkingEnabled: thinkingToPersist,
                thinkingLevel,
                temperature: canSetTemperature ? temperature : null,
                cacheEnabled,
                cacheTtl,
                sttProvider,
                confirmWipe,
              }
            : {
                stateInPromptEnabled,
                datetimeInjectionEnabled,
                toolResultsInHistoryEnabled,
                debugEnabled,
              },
        );
        onUpdate(updated);
      }

      // Clear input fields after save
      clearAllSecretValues();

      toast.success(t("settings.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    // Switching the embedder (openai↔bedrock) abandons the old embedding space —
    // existing memories + knowledge are wiped, not converted. Warn before saving
    // so the loss is explicit and confirmed. Changing only the chat LLM never
    // triggers this.
    const embeddingChanged =
      embeddingProvider !== ((instance.embeddingProvider as "openai" | "bedrock" | undefined) ?? "openai");
    if (embeddingChanged) {
      setWipeOpen(true);
      return;
    }
    await performSave(false);
  };

  const handleWipeConfirm = async () => {
    setWipeOpen(false);
    await performSave(true);
  };

  const handleWipeCancel = () => {
    setWipeOpen(false);
    // Revert the embedder selection back to the persisted instance value.
    setEmbeddingProvider((instance.embeddingProvider as "openai" | "bedrock" | undefined) ?? "openai");
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const handleRemoveSecret = async (key: string) => {
    try {
      await api.secrets.delete(instance.slug, key);
      setSecrets((prev) => prev.filter((s) => s.key !== key));
      toast.success(t("common.deleted"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    }
  };

  // The tools' and hooks' required secrets: a key exists because a tool asked
  // for it, so it belongs beside the tool list, not beside the model picker.
  // Reads `toolSecretSpecs`, NOT the raw specs — a provider credential a tool
  // happens to declare is rendered by Credenziali and nowhere else.
  const requiredSecretsBlock = (
    <>
        {toolSecretSpecs.length > 0 ? (
          /* No card and no heading: the section's own title says what these are,
             and the box around a handful of fields framed nothing. */
          <div className="space-y-4">
            {toolSecretSpecs.map((spec) => {
              const label = spec.label ?? humanizeSecretKey(spec.key);
              if (spec.type === "select") {
                return (
                  <ToolSelectField
                    key={spec.key}
                    label={label}
                    description={spec.description}
                    configured={isConfigured(spec.key)}
                    value={secretValue(spec.key)}
                    choices={spec.choices ?? []}
                    onChange={(v) => setSecretValue(spec.key, v)}
                    configuredLabel={t("settings.tab.configured")}
                    notConfiguredLabel={t("settings.tab.notConfigured")}
                  />
                );
              }
              if (spec.sensitive === false) {
                return (
                  <ReadableField
                    key={spec.key}
                    label={label}
                    sublabel={spec.description}
                    value={secretValue(spec.key)}
                    onChange={(v) => setSecretValue(spec.key, v)}
                    configured={isConfigured(spec.key)}
                    placeholder={isConfigured(spec.key) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
                    onRemove={isConfigured(spec.key) ? () => handleRemoveSecret(spec.key) : undefined}
                  />
                );
              }
              return (
                <SecretField
                  key={spec.key}
                  label={label}
                  sublabel={spec.description}
                  value={secretValue(spec.key)}
                  onChange={(v) => setSecretValue(spec.key, v)}
                  configured={isConfigured(spec.key)}
                  visible={secretVisible(spec.key)}
                  onToggleVisibility={() => toggleSecretVisibility(spec.key)}
                  placeholder={isConfigured(spec.key) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
                  onRemove={isConfigured(spec.key) ? () => handleRemoveSecret(spec.key) : undefined}
                />
              );
            })}
          </div>
        ) : (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("settings.tab.noRequiredSecrets")}
          </p>
        )}
    </>
  );

  /*
    Provider credentials — one block per provider, from the shared
    PROVIDER_SECRET_SECTIONS the organization page renders too.

    ONE visibility rule for every provider (generalized from what the AWS card
    already did): a block shows when that provider is selected for chat, the
    embedder or STT. The selects on the model page drive it off the loaded
    instance, so a provider is authenticable as soon as it is chosen.

    SECRET_READ only (hidden for member/viewer).
  */
  const providerCredentialsBlock = (
    <>
      {canReadSecrets &&
        PROVIDER_SECRET_SECTIONS.filter((s) => providerSectionIsCredential(s.id)).map(
          (providerSection) => (
            <section key={providerSection.id} className="space-y-4 rounded-lg border p-4">
              <div>
                <Label className="text-base font-medium">{t(providerSection.titleKey)}</Label>
                {providerSection.helpKey && (
                  <p className="text-sm text-muted-foreground">{t(providerSection.helpKey)}</p>
                )}
              </div>

              {providerSection.fields.map((field) => {
                const placeholder = isConfigured(field.key)
                  ? t("settings.tab.keyPlaceholderSet")
                  : t(field.placeholderKey ?? "settings.tab.keyPlaceholder");
                const shared = {
                  label: t(field.labelKey),
                  value: secretValue(field.key),
                  onChange: (v: string) => setSecretValue(field.key, v),
                  configured: isConfigured(field.key),
                  placeholder,
                  onRemove: isConfigured(field.key)
                    ? () => handleRemoveSecret(field.key)
                    : undefined,
                };
                // A region is config, not a credential — never masked.
                return field.sensitive === false ? (
                  <ReadableField key={field.key} {...shared} />
                ) : (
                  <SecretField
                    key={field.key}
                    {...shared}
                    visible={secretVisible(field.key)}
                    onToggleVisibility={() => toggleSecretVisibility(field.key)}
                  />
                );
              })}

              {providerSection.id === "aws" && (
                <div className="flex items-start gap-2 rounded-md bg-blue-50 p-3 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-sm">{t("settings.tab.awsFallbackNote")}</p>
                </div>
              )}
            </section>
          ),
        )}

      {/* Deepgram is not a PROVIDER_SECRET_SECTIONS entry — it is reached only by
          the speech-to-text picker — but its key is a credential, and credentials
          have one home now. Shown whatever the picker currently says, for the
          reason the provider sections above are. */}
      {canReadSecrets && (
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.stt")}</Label>
          </div>
          <SecretField
            label={t("settings.tab.deepgramKey")}
            value={secretValue(SECRET_KEYS.DEEPGRAM)}
            onChange={(v) => setSecretValue(SECRET_KEYS.DEEPGRAM, v)}
            configured={isConfigured(SECRET_KEYS.DEEPGRAM)}
            visible={secretVisible(SECRET_KEYS.DEEPGRAM)}
            onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.DEEPGRAM)}
            placeholder={
              isConfigured(SECRET_KEYS.DEEPGRAM)
                ? t("settings.tab.keyPlaceholderSet")
                : t("settings.tab.keyPlaceholder")
            }
            onRemove={
              isConfigured(SECRET_KEYS.DEEPGRAM)
                ? () => handleRemoveSecret(SECRET_KEYS.DEEPGRAM)
                : undefined
            }
          />
        </section>
      )}
    </>
  );

  if (loading) {
    return <div className="animate-pulse space-y-4">
      <div className="h-48 rounded-lg bg-muted" />
      <div className="h-32 rounded-lg bg-muted" />
      <div className="h-48 rounded-lg bg-muted" />
    </div>;
  }

  if (section === "credentials") {
    return <div className="space-y-8">{providerCredentialsBlock}</div>;
  }

  // The tools' own keys, beside the tool list — not with the provider ones.
  if (section === "toolSecrets") {
    return <div className="space-y-8">{requiredSecretsBlock}</div>;
  }

  /*
    Behaviour parameters — what the engine puts in front of the model on every
    turn, and what it keeps afterwards. A sibling of the model picker rather than
    a destination of their own: none of them is a property of WHICH model runs,
    but all of them are read while deciding how the agent thinks.
  */
  const behaviourParamsBlock = (
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.params")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.tab.paramsHelp")}</p>
          </div>

          {/*
            Conversation state store visibility. When on, the engine renders the
            per-conversation state (read-only) into the system prompt. Default off
            keeps the state purely tool-to-tool. Not model-gated.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-state-in-prompt" className="text-sm font-medium">
                {t("settings.tab.stateInPrompt")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.stateInPromptHelp")}
              </p>
            </div>
            <Switch
              id="agent-state-in-prompt"
              checked={stateInPromptEnabled}
              onCheckedChange={setStateInPromptEnabled}
            />
          </div>

          {/*
            Datetime injection. When on, the engine injects the current date/time
            into every turn as a <current_datetime> tag. Default on; off = a
            time-agnostic assistant.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-datetime-injection" className="text-sm font-medium">
                {t("settings.tab.datetimeInjection")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.datetimeInjectionHelp")}
              </p>
            </div>
            <Switch
              id="agent-datetime-injection"
              checked={datetimeInjectionEnabled}
              onCheckedChange={setDatetimeInjectionEnabled}
            />
          </div>

          {/*
            Tool-result replay. When on, the engine reconstructs prior-turn
            tool_use/tool_result blocks (truncated) into the model's history so it
            retains what tools returned across turns. Default off (extra tokens).
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-tool-results-history" className="text-sm font-medium">
                {t("settings.tab.toolResultsInHistory")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.toolResultsInHistoryHelp")}
              </p>
            </div>
            <Switch
              id="agent-tool-results-history"
              checked={toolResultsInHistoryEnabled}
              onCheckedChange={setToolResultsInHistoryEnabled}
            />
          </div>

          {/*
            DEBUG mode. When on, the engine persists the exact LLM request payload
            (full system prompt, the messages array sent, and the tool definitions)
            per turn, viewable from the playground / conversation message detail.
            Default off — heavy and stores PII at rest.
          */}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="agent-debug" className="text-sm font-medium">
                {t("settings.tab.debug")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("settings.tab.debugHelp")}</p>
            </div>
            <Switch id="agent-debug" checked={debugEnabled} onCheckedChange={setDebugEnabled} />
          </div>
        </section>
  );

  /* The Parametri page is only this block — memory and diagnostics sit beside it,
     rendered by `params-tab.tsx`, each with its own save. */
  if (section === "params") {
    return <div className="space-y-8">{behaviourParamsBlock}</div>;
  }


  return (
    <div className="space-y-8">
      {/* AI Model */}
      <section className="space-y-4 rounded-lg border p-4">
        <div className="flex items-start justify-between">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.aiModel")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.tab.aiModelHelp")}
            </p>
          </div>
          {modelsData && (
            <Dialog open={pricingOpen} onOpenChange={setPricingOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
                  <Info className="h-3.5 w-3.5" />
                  {t("settings.tab.viewPricing")}
                </Button>
              </DialogTrigger>
              {/* sm:max-w-6xl (with the sm: variant) is required to override
                  shadcn's default sm:max-w-lg — a plain max-w-6xl is a different
                  variant, so tailwind-merge keeps both and the narrow default wins
                  from the sm breakpoint up. */}
              <DialogContent className="max-h-[85vh] w-[95vw] sm:max-w-6xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{t("settings.tab.pricingTitle")}</DialogTitle>
                  <p className="text-sm text-muted-foreground">{t("settings.tab.pricingClickHint")}</p>
                </DialogHeader>
                <div className="space-y-4">
                  {/* Toolbar: free-text search + provider filter */}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={catalogSearch}
                        onChange={(e) => setCatalogSearch(e.target.value)}
                        placeholder={t("settings.tab.catalogSearchPlaceholder")}
                        className="pl-8"
                      />
                    </div>
                    <Select value={catalogProvider} onValueChange={setCatalogProvider}>
                      <SelectTrigger className="sm:w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("settings.tab.catalogAllProviders")}</SelectItem>
                        {providerNames.map((p) => (
                          <SelectItem key={p} value={p}>
                            {BRAND_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Single flattened table with a Provider column. table-fixed so the
                      model-id column absorbs the leftover width and long IDs wrap
                      (break-all) instead of overflowing into the price columns. */}
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        {catalogSortHead("settings.tab.provider", "provider", { width: "w-28" })}
                        {catalogSortHead("settings.tab.model", "model")}
                        {catalogSortHead("settings.tab.pricingInput", "input", { width: "w-20", right: true })}
                        {catalogSortHead("settings.tab.pricingOutput", "output", { width: "w-20", right: true })}
                        {catalogSortHead("settings.tab.pricingCacheRead", "cacheRead", { width: "w-24", right: true })}
                        {catalogSortHead("settings.tab.pricingCacheWrite", "cacheWrite", { width: "w-24", right: true })}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {catalogRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                            {t("settings.tab.catalogNoResults")}
                          </TableCell>
                        </TableRow>
                      ) : (
                        catalogRows.map((m) => {
                          const isSelected = provider === m.provider && model === m.id;
                          // A cache rate "doesn't count" when it's free (0) or billed at the
                          // full input rate (no discount — Nebius / non-cacheable models): show
                          // "—" instead of a figure that implies a saving.
                          const fmtCache = (v: number | undefined) => {
                            const val = v ?? m.costInput;
                            return val === 0 || val === m.costInput ? "—" : `$${val.toFixed(2)}`;
                          };
                          return (
                            <TableRow
                              key={`${m.provider}:${m.id}`}
                              className={cn("cursor-pointer", isSelected ? "bg-primary/10" : "hover:bg-muted/50")}
                              onClick={() => {
                                setProvider(m.provider);
                                setModel(m.id);
                                setPricingOpen(false);
                              }}
                            >
                              <TableCell className="align-top text-xs">
                                {BRAND_NAMES[m.provider] ?? m.provider.charAt(0).toUpperCase() + m.provider.slice(1)}
                              </TableCell>
                              {/* whitespace-normal overrides shadcn's cell default of
                                  whitespace-nowrap — without it break-all can't wrap and
                                  long model ids overflow into the price columns. */}
                              <TableCell className="align-top whitespace-normal">
                                <span className="block break-all font-mono text-xs">{m.id}</span>
                                {m.tier && (
                                  <Badge variant="secondary" className="mt-1 text-[10px]">
                                    {m.tier}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums">
                                ${m.costInput.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums">
                                ${m.costOutput.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                                {fmtCache(m.costCacheRead)}
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                                {fmtCache(m.costCacheWrite)}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-muted-foreground">{t("settings.tab.pricingNote")}</p>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("settings.tab.provider")}</Label>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger>
                <SelectValue placeholder={t("settings.tab.systemDefault")} />
              </SelectTrigger>
              <SelectContent>
                {providerNames.map((p) => (
                  <SelectItem key={p} value={p}>
                    {BRAND_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.tab.model")}</Label>
            <Select value={model} onValueChange={setModel} disabled={!provider}>
              <SelectTrigger>
                <SelectValue placeholder={t("settings.tab.systemDefault")} />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/*
          Embedder provider — independent of the chat LLM above. Only OpenAI and
          Bedrock embed (Anthropic has no embeddings API). Changing it permanently
          wipes memories + knowledge (vectors are provider-specific).
        */}
        <div className="space-y-2">
          <Label>{t("settings.tab.embedder")}</Label>
          <Select
            value={embeddingProvider}
            onValueChange={(v) => setEmbeddingProvider(v as "openai" | "bedrock")}
          >
            <SelectTrigger aria-label={t("settings.tab.embedder")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">{BRAND_NAMES["openai"] ?? "OpenAI"}</SelectItem>
              <SelectItem value="bedrock">{BRAND_NAMES["bedrock"] ?? "Bedrock"}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.tab.embedderHint")}</p>
        </div>

        {/*
          Extended thinking toggle. Always rendered — disabled (not hidden) when
          the selected model does not support thinking, so the control never
          vanishes on a model switch. The user's preference is preserved in
          state across model changes so it reapplies if they switch back to a
          capable model.
        */}
        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label className="text-sm font-medium">
              {t("settings.tab.thinking")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {alwaysOnThinking
                ? t("settings.tab.thinkingAlwaysOn")
                : canEnableThinking
                  ? t("settings.tab.thinkingHelp")
                  : t("settings.tab.thinkingUnavailable")}
            </p>
          </div>
          <Switch
            checked={alwaysOnThinking || thinkingEnabled}
            disabled={!canEnableThinking || alwaysOnThinking}
            onCheckedChange={setThinkingEnabled}
          />
        </div>

        {/*
          Reasoning level (effort). Applied by every provider: OpenAI/Nebius
          reasoning_effort, Bedrock/Anthropic effort or budget per model. Shown
          for ANY thinking-capable model whenever thinking is on (incl. always-on
          models like gpt-oss). Portable set low|medium|high.
        */}
        {effectiveThinkingEnabled && (
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">
                {t("settings.tab.reasoningLevel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.reasoningLevelHelp")}
              </p>
            </div>
            <Select value={thinkingLevel} onValueChange={setThinkingLevel}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Options are the model's actual accepted levels (live-verified,
                    from /models) — e.g. gpt-5.x add "xhigh", adaptive Claude add
                    "xhigh"+"max". Fallback to the three presets if unknown. */}
                {(selectedModelInfo?.reasoningLevels?.length ? selectedModelInfo.reasoningLevels : ["low", "medium", "high"]).map((lvl) => (
                  <SelectItem key={lvl} value={lvl}>
                    {REASONING_LEVEL_LABELS[lvl] ?? lvl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/*
          Sampling temperature control. Shown for all models but disabled for
          reasoning/o-series models (supportsTemperature: false) and, under extended
          thinking, for models that reject temperature+reasoning together
          (supportsTemperatureWithThinking: false — Anthropic/OpenAI 1P).
        */}
        <div className="space-y-2 border-t pt-4">
          <Label htmlFor="temperature">{t("settings.temperature.label")}</Label>
          <Input
            id="temperature"
            type="number"
            min={0}
            max={2}
            step={0.1}
            disabled={!canSetTemperature}
            value={temperature ?? ""}
            placeholder={t("settings.temperature.placeholder")}
            onChange={(e) =>
              setTemperature(e.target.value === "" ? null : Number(e.target.value))
            }
          />
          {!canSetTemperature && (
            <p className="text-xs text-muted-foreground">
              {!selectedModelInfo?.supportsTemperature
                ? t("settings.temperature.unsupportedReasoningHint")
                : t("settings.temperature.unsupportedThinkingHint")}
            </p>
          )}
        </div>

        {/*
          Prompt-cache control. Anthropic/Bedrock honour the on/off switch (off
          skips the cache marker → no cache write). OpenAI caches automatically
          (locked on); Nebius has no prompt-cache API (unavailable). TTL applies to
          the Anthropic cross-turn breakpoint (Bedrock is 5m fixed).
        */}
        <div className="border-t pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">{t("settings.tab.cache")}</Label>
              <p className="text-xs text-muted-foreground">
                {provider === "openai"
                  ? t("settings.tab.cacheAutomaticHelp")
                  : provider === "nebius"
                    ? t("settings.tab.cacheNebiusHelp")
                    : t("settings.tab.cacheHelp")}
              </p>
            </div>
            <Switch
              checked={provider === "openai" || provider === "nebius" ? true : cacheEnabled}
              onCheckedChange={setCacheEnabled}
              disabled={provider === "openai" || provider === "nebius"}
            />
          </div>
          {(provider === "anthropic" || provider === "bedrock") && cacheEnabled && (
            <div className="mt-3 flex items-center justify-between gap-4">
              <Label className="text-sm">{t("settings.tab.cacheTtl")}</Label>
              {provider === "anthropic" ? (
                <Select value={cacheTtl} onValueChange={setCacheTtl}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5m">{t("settings.tab.cacheTtl5m")}</SelectItem>
                    <SelectItem value="1h">{t("settings.tab.cacheTtl1h")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-xs text-muted-foreground">{t("settings.tab.cacheTtlBedrock")}</span>
              )}
            </div>
          )}
        </div>

      </section>


      {/* Audio (STT) — which engine transcribes voice notes. Its key, when the
          choice needs one, is in Credenziali with every other key. */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.stt")}</Label>
          <p className="text-sm text-muted-foreground">{t("settings.tab.sttHelp")}</p>
        </div>

        <div className="space-y-2">
          <Label>{t("settings.tab.sttProvider")}</Label>
          <Select value={sttProvider} onValueChange={(v) => setSttProvider(v as STTProvider)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI Whisper</SelectItem>
              <SelectItem value="aws">Amazon Transcribe</SelectItem>
              <SelectItem value="deepgram">Deepgram</SelectItem>
              <SelectItem value="disabled">{t("settings.tab.sttProviderDisabled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {/* Provider-change destructive wipe confirmation */}
      <AlertDialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("memory.wipe.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("memory.wipe.body", {
                provider: BRAND_NAMES[provider] ?? provider,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleWipeCancel}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleWipeConfirm}>
              {t("memory.wipe.primary")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


/** The "you need not configure this" line, shown only when nothing local overrides it. */

// ── Readable Field Component ────────────────────────────────────────
// For tool config fields with sensitive === false (e.g. a base URL):
// plain cleartext input, prefilled from currentValue. No eye toggle.

interface ReadableFieldProps {
  label: string;
  sublabel?: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  placeholder: string;
  onRemove?: () => void;
}

function ReadableField({
  label,
  sublabel,
  value,
  onChange,
  configured,
  placeholder,
  onRemove,
}: ReadableFieldProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        <SecretStatusBadge configured={configured} />
      </div>
      {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
      <div className="flex gap-2">
        <Input
          type="text"
          className="flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {onRemove && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("settings.tab.removeKeyTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.tab.removeKeyDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onRemove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("settings.tab.removeKey")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}

// ── Secret Field Component ──────────────────────────────────────────


interface ToolSelectFieldProps {
  label: string;
  description?: string;
  configured: boolean;
  value: string;
  choices: string[];
  onChange: (value: string) => void;
  configuredLabel: string;
  notConfiguredLabel: string;
}

function ToolSelectField({
  label,
  description,
  configured,
  value,
  choices,
  onChange,
  configuredLabel,
  notConfiguredLabel,
}: ToolSelectFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        <Badge variant={configured ? "default" : "secondary"} className="text-xs">
          {configured ? configuredLabel : notConfiguredLabel}
        </Badge>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
