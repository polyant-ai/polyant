// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Trash2, AlertTriangle, Info } from "lucide-react";
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
import { api, getUserErrorMessage, type Instance, type SecretStatus, type ModelsResponse, type RequiredSecretSpec } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}

const SECRET_KEYS = {
  OPENAI: "openai_api_key",
  ANTHROPIC: "anthropic_api_key",
  AWS_ACCESS_KEY_ID: "aws_access_key_id",
  AWS_SECRET_ACCESS_KEY: "aws_secret_access_key",
  AWS_REGION: "aws_region",
  LANGSMITH: "langsmith_api_key",
  AUTH: "auth_api_key",
  DEEPGRAM: "deepgram_api_key",
} as const;

type STTProvider = "openai" | "aws" | "deepgram";

const BRAND_NAMES: Record<string, string> = {
  hubspot: "HubSpot",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "AWS Bedrock",
  aws: "AWS",
  tavily: "Tavily",
  langsmith: "LangSmith",
};

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

export function SettingsTab({ instance, onUpdate }: Props) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // AI Model settings
  const [provider, setProvider] = useState(instance.provider ?? "");
  const [model, setModel] = useState(instance.model ?? "");
  // Persisted user preference; the toggle below is hidden when the selected
  // model is not thinking-capable, but the state is preserved so that
  // switching back to a capable model reapplies the preference.
  const [thinkingEnabled, setThinkingEnabled] = useState(instance.thinkingEnabled);

  // Conversation state store: render known state read-only into the prompt (default off).
  const [stateInPromptEnabled, setStateInPromptEnabled] = useState(instance.stateInPromptEnabled);

  // Replay prior-turn tool results into the model's cross-turn history (default off).
  const [toolResultsInHistoryEnabled, setToolResultsInHistoryEnabled] = useState(
    instance.toolResultsInHistoryEnabled,
  );

  // DEBUG mode: persist the exact LLM request payload per turn (default off).
  const [debugEnabled, setDebugEnabled] = useState(instance.debugEnabled ?? false);

  // Memory
  const [memoryEnabled, setMemoryEnabled] = useState(instance.memoryEnabled);

  // Knowledge
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(instance.knowledgeEnabled ?? false);

  // Tool secret specs (dynamic, from API). Each entry describes how to render
  // and persist the field (text input vs select dropdown).
  const [toolSecretSpecs, setToolSecretSpecs] = useState<RequiredSecretSpec[]>([]);

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

  // Pricing dialog
  const [pricingOpen, setPricingOpen] = useState(false);


  // Instance-level settings
  const [authEnabled, setAuthEnabled] = useState(instance.authEnabled);
  const [langsmithEnabled, setLangsmithEnabled] = useState(instance.langsmithEnabled);
  const [langsmithProject, setLangsmithProject] = useState(instance.langsmithProject ?? "");

  // Audio (STT)
  const [sttProvider, setSttProvider] = useState<STTProvider>(
    (instance.sttProvider as STTProvider | null) ?? "openai",
  );

  useEffect(() => {
    Promise.all([
      api.secrets.list(instance.slug),
      api.models.list(),
      api.tools.requiredSecrets(instance.slug),
    ]).then(([secretsRes, modelsRes, toolSecretsRes]) => {
      setSecrets(secretsRes.secrets);
      setModelsData(modelsRes);
      setToolSecretSpecs(toolSecretsRes.requiredSecrets);
    }).catch(() => {
      toast.error(t("settings.tab.loadFailed"));
    }).finally(() => setLoading(false));
  }, [instance.slug]);

  useEffect(() => {
    setSecretFields((prev) => {
      const next = { ...prev };
      for (const spec of toolSecretSpecs) {
        if (!(spec.key in next)) {
          // Pre-fill `select` fields with their server-side current value so the
          // dropdown shows the saved choice. `text` (true secret) fields stay empty.
          const initialValue = spec.currentValue ?? "";
          next[spec.key] = { value: initialValue, initial: initialValue, visible: false };
        }
      }
      return next;
    });
  }, [toolSecretSpecs]);

  const isConfigured = (key: string) =>
    secrets.some((s) => s.key === key && s.configured);

  const providerNames = modelsData ? Object.keys(modelsData.providers) : [];
  const availableModels = provider && modelsData?.providers[provider]
    ? modelsData.providers[provider].models
    : [];
  const selectedModelInfo = availableModels.find((m) => m.id === model);
  // Show the "Extended thinking" toggle only when the chosen model supports it.
  // The capability flag is computed server-side (single source of truth in
  // ai-gateway/config.ts), so the UI cannot drift from runtime behaviour.
  const canEnableThinking = !!selectedModelInfo?.supportsThinking;

  // Reset model when provider changes
  const handleProviderChange = (value: string) => {
    setProvider(value);
    setModel("");
  };

  const isDirty =
    provider !== (instance.provider ?? "") ||
    model !== (instance.model ?? "") ||
    thinkingEnabled !== instance.thinkingEnabled ||
    stateInPromptEnabled !== instance.stateInPromptEnabled ||
    toolResultsInHistoryEnabled !== instance.toolResultsInHistoryEnabled ||
    debugEnabled !== (instance.debugEnabled ?? false) ||
    memoryEnabled !== instance.memoryEnabled ||
    knowledgeEnabled !== (instance.knowledgeEnabled ?? false) ||
    Object.values(secretFields).some((f) => f.value !== f.initial) ||
    authEnabled !== instance.authEnabled ||
    langsmithEnabled !== instance.langsmithEnabled ||
    langsmithProject !== (instance.langsmithProject ?? "") ||
    sttProvider !== ((instance.sttProvider as STTProvider | null) ?? "openai");

  const handleSave = async () => {
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

      // 2. Save instance-level settings
      const { instance: updated } = await api.instances.update(instance.slug, {
        provider: provider || null,
        model: model || null,
        memoryEnabled,
        knowledgeEnabled,
        authEnabled,
        thinkingEnabled,
        stateInPromptEnabled,
        toolResultsInHistoryEnabled,
        debugEnabled,
        langsmithEnabled,
        langsmithProject: langsmithProject || null,
        sttProvider,
      });
      onUpdate(updated);

      // Clear input fields after save
      clearAllSecretValues();

      toast.success(t("settings.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
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

  if (loading) {
    return <div className="max-w-2xl animate-pulse space-y-4">
      <div className="h-48 rounded-lg bg-muted" />
      <div className="h-32 rounded-lg bg-muted" />
      <div className="h-48 rounded-lg bg-muted" />
    </div>;
  }

  return (
    <div className="max-w-2xl space-y-8">
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
              <DialogContent className="max-h-[80vh] w-[95vw] max-w-4xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{t("settings.tab.pricingTitle")}</DialogTitle>
                  <p className="text-sm text-muted-foreground">{t("settings.tab.pricingClickHint")}</p>
                </DialogHeader>
                <div className="space-y-6">
                  {Object.entries(modelsData.providers).map(([providerName, { models }]) => (
                    <div key={providerName}>
                      <h4 className="mb-2 text-sm font-semibold">
                        {BRAND_NAMES[providerName] ?? providerName.charAt(0).toUpperCase() + providerName.slice(1)}
                      </h4>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("settings.tab.model")}</TableHead>
                            <TableHead className="w-20 text-right">{t("settings.tab.pricingInput")}</TableHead>
                            <TableHead className="w-20 text-right">{t("settings.tab.pricingOutput")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {models.map((m) => {
                            const isSelected = provider === providerName && model === m.id;
                            return (
                              <TableRow
                                key={m.id}
                                className={`cursor-pointer ${isSelected ? "bg-primary/10" : "hover:bg-muted/50"}`}
                                onClick={() => {
                                  setProvider(providerName);
                                  setModel(m.id);
                                  setPricingOpen(false);
                                }}
                              >
                                <TableCell className="max-w-0">
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
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
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
          Extended thinking toggle. Shown only when the selected model supports
          thinking; the user's preference is preserved in state across model
          changes so it reapplies if they switch back to a capable model.
        */}
        {canEnableThinking && (
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">
                {t("settings.tab.thinking")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.tab.thinkingHelp")}
              </p>
            </div>
            <Switch
              checked={thinkingEnabled}
              onCheckedChange={setThinkingEnabled}
            />
          </div>
        )}

        {/*
          Conversation state store visibility. When on, the engine renders the
          per-conversation state (read-only) into the system prompt. Default off
          keeps the state purely tool-to-tool. Not model-gated.
        */}
        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label className="text-sm font-medium">
              {t("settings.tab.stateInPrompt")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.tab.stateInPromptHelp")}
            </p>
          </div>
          <Switch
            checked={stateInPromptEnabled}
            onCheckedChange={setStateInPromptEnabled}
          />
        </div>

        {/*
          Tool-result replay. When on, the engine reconstructs prior-turn
          tool_use/tool_result blocks (truncated) into the model's history so it
          retains what tools returned across turns. Default off (extra tokens).
        */}
        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label className="text-sm font-medium">
              {t("settings.tab.toolResultsInHistory")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.tab.toolResultsInHistoryHelp")}
            </p>
          </div>
          <Switch
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
            <Label className="text-sm font-medium">
              {t("settings.tab.debug")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.tab.debugHelp")}
            </p>
          </div>
          <Switch
            checked={debugEnabled}
            onCheckedChange={setDebugEnabled}
          />
        </div>
      </section>

      {/* AI Provider API Keys */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.apiKeys")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.apiKeysHelp")}
          </p>
        </div>

        <SecretField
          label={t("settings.tab.openaiKey")}
          value={secretValue(SECRET_KEYS.OPENAI)}
          onChange={(v) => setSecretValue(SECRET_KEYS.OPENAI, v)}
          configured={isConfigured(SECRET_KEYS.OPENAI)}
          visible={secretVisible(SECRET_KEYS.OPENAI)}
          onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.OPENAI)}
          placeholder={isConfigured(SECRET_KEYS.OPENAI) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
          onRemove={isConfigured(SECRET_KEYS.OPENAI) ? () => handleRemoveSecret(SECRET_KEYS.OPENAI) : undefined}
        />

        <SecretField
          label={t("settings.tab.anthropicKey")}
          value={secretValue(SECRET_KEYS.ANTHROPIC)}
          onChange={(v) => setSecretValue(SECRET_KEYS.ANTHROPIC, v)}
          configured={isConfigured(SECRET_KEYS.ANTHROPIC)}
          visible={secretVisible(SECRET_KEYS.ANTHROPIC)}
          onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.ANTHROPIC)}
          placeholder={isConfigured(SECRET_KEYS.ANTHROPIC) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
          onRemove={isConfigured(SECRET_KEYS.ANTHROPIC) ? () => handleRemoveSecret(SECRET_KEYS.ANTHROPIC) : undefined}
        />
      </section>

      {/* AWS Credentials (shown when Bedrock is selected) */}
      {provider === "bedrock" && (
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.awsCredentials")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.tab.awsCredentialsHelp")}
            </p>
          </div>

          <SecretField
            label={t("settings.tab.awsAccessKeyId")}
            value={secretValue(SECRET_KEYS.AWS_ACCESS_KEY_ID)}
            onChange={(v) => setSecretValue(SECRET_KEYS.AWS_ACCESS_KEY_ID, v)}
            configured={isConfigured(SECRET_KEYS.AWS_ACCESS_KEY_ID)}
            visible={secretVisible(SECRET_KEYS.AWS_ACCESS_KEY_ID)}
            onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.AWS_ACCESS_KEY_ID)}
            placeholder={isConfigured(SECRET_KEYS.AWS_ACCESS_KEY_ID) ? t("settings.tab.keyPlaceholderSet") : "AKIA..."}
            onRemove={isConfigured(SECRET_KEYS.AWS_ACCESS_KEY_ID) ? () => handleRemoveSecret(SECRET_KEYS.AWS_ACCESS_KEY_ID) : undefined}
          />

          <SecretField
            label={t("settings.tab.awsSecretAccessKey")}
            value={secretValue(SECRET_KEYS.AWS_SECRET_ACCESS_KEY)}
            onChange={(v) => setSecretValue(SECRET_KEYS.AWS_SECRET_ACCESS_KEY, v)}
            configured={isConfigured(SECRET_KEYS.AWS_SECRET_ACCESS_KEY)}
            visible={secretVisible(SECRET_KEYS.AWS_SECRET_ACCESS_KEY)}
            onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.AWS_SECRET_ACCESS_KEY)}
            placeholder={isConfigured(SECRET_KEYS.AWS_SECRET_ACCESS_KEY) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
            onRemove={isConfigured(SECRET_KEYS.AWS_SECRET_ACCESS_KEY) ? () => handleRemoveSecret(SECRET_KEYS.AWS_SECRET_ACCESS_KEY) : undefined}
          />

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label>{t("settings.tab.awsRegion")}</Label>
              {isConfigured(SECRET_KEYS.AWS_REGION) && (
                <Badge variant="default" className="text-xs">
                  {t("settings.tab.configured")}
                </Badge>
              )}
            </div>
            <Input
              value={secretValue(SECRET_KEYS.AWS_REGION)}
              onChange={(e) => setSecretValue(SECRET_KEYS.AWS_REGION, e.target.value)}
              placeholder={isConfigured(SECRET_KEYS.AWS_REGION) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.awsRegionPlaceholder")}
            />
          </div>

          <div className="flex items-start gap-2 rounded-md bg-blue-50 p-3 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm">{t("settings.tab.awsFallbackNote")}</p>
          </div>
        </section>
      )}

      {/* Memory */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.memory")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.memoryHelp")}
          </p>
        </div>

        <div className="flex items-center justify-between">
          <Label>{t("settings.tab.memory")}</Label>
          <Switch
            checked={memoryEnabled}
            onCheckedChange={setMemoryEnabled}
          />
        </div>

        {memoryEnabled && !isConfigured(SECRET_KEYS.OPENAI) && secretValue(SECRET_KEYS.OPENAI) === "" && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm">{t("settings.tab.memoryOpenaiWarning")}</p>
          </div>
        )}
      </section>

      {/* Knowledge Base */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.knowledge")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.knowledgeHelp")}
          </p>
        </div>

        <div className="flex items-center justify-between">
          <Label>{t("settings.tab.knowledge")}</Label>
          <Switch
            checked={knowledgeEnabled}
            onCheckedChange={setKnowledgeEnabled}
          />
        </div>

        {knowledgeEnabled && !isConfigured(SECRET_KEYS.OPENAI) && secretValue(SECRET_KEYS.OPENAI) === "" && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm">{t("settings.tab.knowledgeOpenaiWarning")}</p>
          </div>
        )}
      </section>

      {/* Audio (STT) */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.stt")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.sttHelp")}
          </p>
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
            </SelectContent>
          </Select>
        </div>

        {sttProvider === "deepgram" && (
          <SecretField
            label={t("settings.tab.deepgramKey")}
            value={secretValue(SECRET_KEYS.DEEPGRAM)}
            onChange={(v) => setSecretValue(SECRET_KEYS.DEEPGRAM, v)}
            configured={isConfigured(SECRET_KEYS.DEEPGRAM)}
            visible={secretVisible(SECRET_KEYS.DEEPGRAM)}
            onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.DEEPGRAM)}
            placeholder={isConfigured(SECRET_KEYS.DEEPGRAM) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
            onRemove={isConfigured(SECRET_KEYS.DEEPGRAM) ? () => handleRemoveSecret(SECRET_KEYS.DEEPGRAM) : undefined}
          />
        )}
      </section>

      {/* Tool Secrets */}
      {toolSecretSpecs.length > 0 ? (
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.toolSecrets")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.tab.toolSecretsHelp")}
            </p>
          </div>

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
        </section>
      ) : (
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-base font-medium">{t("settings.tab.toolSecrets")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.tab.noToolSecrets")}
            </p>
          </div>
        </section>
      )}

      {/* API Authentication */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.auth")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.authHelp")}
          </p>
        </div>

        <div className="flex items-center justify-between">
          <Label>{t("settings.tab.authEnabled")}</Label>
          <Switch
            checked={authEnabled}
            onCheckedChange={setAuthEnabled}
          />
        </div>

        {authEnabled && (
          <SecretField
            label={t("settings.tab.authApiKey")}
            value={secretValue(SECRET_KEYS.AUTH)}
            onChange={(v) => setSecretValue(SECRET_KEYS.AUTH, v)}
            configured={isConfigured(SECRET_KEYS.AUTH)}
            visible={secretVisible(SECRET_KEYS.AUTH)}
            onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.AUTH)}
            placeholder={isConfigured(SECRET_KEYS.AUTH) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.authKeyPlaceholder")}
            onRemove={isConfigured(SECRET_KEYS.AUTH) ? () => handleRemoveSecret(SECRET_KEYS.AUTH) : undefined}
          />
        )}
      </section>

      {/* LangSmith Tracing */}
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("settings.tab.langsmith")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.tab.langsmithHelp")}
          </p>
        </div>

        <div className="flex items-center justify-between">
          <Label>{t("settings.tab.langsmithEnabled")}</Label>
          <Switch
            checked={langsmithEnabled}
            onCheckedChange={setLangsmithEnabled}
          />
        </div>

        {langsmithEnabled && (
          <>
            <div className="space-y-2">
              <Label>{t("settings.tab.langsmithProject")}</Label>
              <Input
                value={langsmithProject}
                onChange={(e) => setLangsmithProject(e.target.value)}
                placeholder={t("settings.tab.langsmithProjectPlaceholder")}
              />
            </div>

            <SecretField
              label={t("settings.tab.langsmithApiKey")}
              value={secretValue(SECRET_KEYS.LANGSMITH)}
              onChange={(v) => setSecretValue(SECRET_KEYS.LANGSMITH, v)}
              configured={isConfigured(SECRET_KEYS.LANGSMITH)}
              visible={secretVisible(SECRET_KEYS.LANGSMITH)}
              onToggleVisibility={() => toggleSecretVisibility(SECRET_KEYS.LANGSMITH)}
              placeholder={isConfigured(SECRET_KEYS.LANGSMITH) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
              onRemove={isConfigured(SECRET_KEYS.LANGSMITH) ? () => handleRemoveSecret(SECRET_KEYS.LANGSMITH) : undefined}
            />
          </>
        )}
      </section>

    </div>
  );
}

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
        <Badge variant={configured ? "default" : "secondary"} className="text-xs">
          {configured ? t("settings.tab.configured") : t("settings.tab.notConfigured")}
        </Badge>
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

interface SecretFieldProps {
  label: string;
  sublabel?: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  visible: boolean;
  onToggleVisibility: () => void;
  placeholder: string;
  onRemove?: () => void;
}

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

function SecretField({
  label,
  sublabel,
  value,
  onChange,
  configured,
  visible,
  onToggleVisibility,
  placeholder,
  onRemove,
}: SecretFieldProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        <Badge variant={configured ? "default" : "secondary"} className="text-xs">
          {configured ? t("settings.tab.configured") : t("settings.tab.notConfigured")}
        </Badge>
      </div>
      {sublabel && (
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={visible ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
          />
          <button
            type="button"
            onClick={onToggleVisibility}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
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
                <AlertDialogAction onClick={onRemove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
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
