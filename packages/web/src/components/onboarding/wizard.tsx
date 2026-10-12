// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, Minus } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, getUserErrorMessage } from "@/lib/api";
import type { ModelsResponse, OnboardingPatch, WizardStepId, WizardStepState } from "@/lib/api-types";
import { useI18n } from "@/lib/i18n/context";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";
import { WIZARD_STEP_IDS, stepState } from "@/lib/onboarding/steps";
import {
  EMPTY_DRAFT,
  addKnowledgeText,
  applyProviderConfig,
  createAgentFromDraft,
  disableWeb,
  enableWebWithKey,
  regenerateAgentKey,
  setWebAuth,
  typedKeys,
  type WizardDraft,
} from "@/lib/onboarding/wizard-actions";
import { sendWizardChat } from "@/lib/onboarding/wizard-chat";
import { resolveNavScope } from "@/lib/tenant/nav-href";
import { orgPath, workspacePath } from "@/lib/tenant/paths";
import { useTenant } from "@/lib/tenant/tenant-context";
import { SECRET_KEYS } from "@/lib/provider-secrets";
import { cn } from "@/lib/utils";
import { WizardStepBody, type AgentRef, type ChatLine, type StepProps, type WebState } from "./wizard-steps";

type Confirm = null | "skipAll" | "never";

const NO_WEB: WebState = { loaded: false, enabled: false, authEnabled: true, keyConfigured: false, freshKey: null };

/**
 * The full-screen guided setup. Provider, key and model are collected in memory and
 * written the moment the agent is created, because an agent is the only thing they
 * can be saved on. Each later step acts on that agent through the same api.ts calls
 * the panel's own pages use.
 */
export function Wizard() {
  const { t } = useI18n();
  const router = useRouter();
  const tenant = useTenant();
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  const { onboarding, wizard, update, finishWizard } = useOnboarding();
  const scope = resolveNavScope(tenant, params);

  const [index, setIndex] = useState(wizard.step);
  const [phase, setPhase] = useState<"steps" | "final">("steps");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [draft, setDraft] = useState<WizardDraft>(EMPTY_DRAFT);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [agent, setAgent] = useState<AgentRef | null>(null);
  const [agentOptions, setAgentOptions] = useState<AgentRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [web, setWeb] = useState<WebState>(NO_WEB);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [sending, setSending] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [kbTitle, setKbTitle] = useState("");
  const [kbText, setKbText] = useState("");
  const [kbAdded, setKbAdded] = useState(false);
  const [applied, setApplied] = useState({ keys: false, model: false });
  const chatId = useRef(crypto.randomUUID());
  const abort = useRef<AbortController | null>(null);

  const id = WIZARD_STEP_IDS[index];

  // The catalog and the agents that already exist, once.
  useEffect(() => {
    let active = true;
    api.models
      .list()
      .then((m) => active && setModels(m))
      .catch(() => active && setModelsFailed(true));
    api.instances
      .list()
      .then((r) => active && setAgentOptions(r.instances.map((i) => ({ slug: i.slug, name: i.name }))))
      .catch(() => {});
    return () => {
      active = false;
      abort.current?.abort();
    };
  }, []);

  // What the Web channel looks like for the chosen agent.
  const loadWeb = useCallback(async (slug: string) => {
    try {
      const [channels, instance, secrets] = await Promise.all([
        api.channels.list(slug),
        api.instances.get(slug),
        api.secrets.list(slug).catch(() => ({ secrets: [] })),
      ]);
      setWeb((prev) => ({
        loaded: true,
        enabled: channels.channels.find((c) => c.channelType === "web")?.enabled ?? false,
        authEnabled: instance.instance.authEnabled,
        keyConfigured: secrets.secrets.some((s) => s.key === SECRET_KEYS.AUTH && s.configured),
        freshKey: prev.freshKey,
      }));
    } catch {
      setWeb((prev) => ({ ...prev, loaded: true }));
    }
  }, []);
  useEffect(() => {
    if (agent) void loadWeb(agent.slug);
  }, [agent, loadWeb]);

  const record = useCallback(
    (steps: Partial<Record<WizardStepId, WizardStepState>>) => update({ steps }),
    [update],
  );

  const patchDraft = useCallback((patch: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...patch })), []);

  const run = useCallback(
    async (work: () => Promise<void>, failure: string) => {
      setBusy(true);
      setError(null);
      try {
        await work();
      } catch (err) {
        setError(getUserErrorMessage(err, failure));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onCreateAgent = () =>
    void run(async () => {
      const created = await createAgentFromDraft(draft);
      setAgent({ slug: created.instance.slug, name: created.instance.name });
      setApplied({ keys: created.applied.keysSaved, model: created.applied.modelSaved });
      const steps: Partial<Record<WizardStepId, WizardStepState>> = { agent: "done" };
      if (created.applied.keysSaved) steps.provider = "done";
      if (created.applied.modelSaved) steps.model = "done";
      record(steps);
      toast.success(t("instances.create.success"));
    }, t("instances.create.error"));

  const pickAgent = (slug: string) => {
    const found = agentOptions.find((a) => a.slug === slug);
    if (found) setAgent(found);
  };

  /** A key or model chosen after the agent exists is written at once. */
  const applyToExisting = useCallback(async () => {
    if (!agent) return;
    const result = await applyProviderConfig(agent.slug, draft);
    setApplied((a) => ({ keys: a.keys || result.keysSaved, model: a.model || result.modelSaved }));
    const steps: Partial<Record<WizardStepId, WizardStepState>> = {};
    if (result.keysSaved) steps.provider = "done";
    if (result.modelSaved) steps.model = "done";
    if (Object.keys(steps).length > 0) record(steps);
  }, [agent, draft, record]);

  const onToggleWeb = (on: boolean) =>
    void run(async () => {
      if (!agent) return;
      if (on) {
        const key = await enableWebWithKey(agent.slug);
        setWeb((w) => ({ ...w, enabled: true, authEnabled: true, keyConfigured: true, freshKey: key }));
        setKeyInput("");
      } else {
        await disableWeb(agent.slug);
        setWeb((w) => ({ ...w, enabled: false }));
      }
    }, t("settings.tab.saveFailed"));

  const onToggleAuth = (on: boolean) =>
    void run(async () => {
      if (!agent) return;
      if (on && !web.keyConfigured && !web.freshKey) {
        const key = await regenerateAgentKey(agent.slug);
        setWeb((w) => ({ ...w, keyConfigured: true, freshKey: key }));
      }
      await setWebAuth(agent.slug, on);
      setWeb((w) => ({ ...w, authEnabled: on }));
    }, t("settings.tab.saveFailed"));

  const onRegenerateKey = () =>
    void run(async () => {
      if (!agent) return;
      const key = await regenerateAgentKey(agent.slug);
      setWeb((w) => ({ ...w, keyConfigured: true, freshKey: key }));
    }, t("settings.tab.saveFailed"));

  const sendChat = (text: string) => {
    if (!agent) return;
    setError(null);
    const history: ChatLine[] = [...lines, { role: "user", content: text }];
    setLines([...history, { role: "assistant", content: "" }]);
    setSending(true);
    abort.current = new AbortController();
    sendWizardChat(
      agent.slug,
      {
        messages: history,
        chatId: chatId.current,
        agentKey: web.freshKey ?? (keyInput.trim() || undefined),
        signal: abort.current.signal,
        errors: { network: t("onboarding.chat.network"), http: (s) => t("onboarding.chat.http", { status: s }) },
      },
      {
        onText: (delta) =>
          setLines((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          }),
      },
    )
      .catch((err: unknown) => {
        if (abort.current?.signal.aborted) return;
        setLines((prev) => prev.slice(0, -1));
        setError(err instanceof Error ? err.message : t("onboarding.chat.network"));
      })
      .finally(() => setSending(false));
  };

  const addKnowledge = () =>
    void run(async () => {
      if (!agent) return;
      await addKnowledgeText(agent.slug, kbTitle, kbText);
      setKbAdded(true);
    }, t("knowledge.tab.uploadFailed"));

  const doneNow: Record<WizardStepId, boolean> = {
    welcome: true,
    provider: applied.keys,
    model: applied.model,
    agent: !!agent,
    channels: web.enabled,
    chat: lines.some((l) => l.role === "user"),
    knowledge: kbAdded,
  };

  /** Leaving a step records whether it was done or left open. */
  const leaveStep = async (direction: 1 | -1, skipped = false) => {
    const pending =
      !agent && ((id === "provider" && typedKeys(draft).length > 0) || (id === "model" && draft.model !== ""));
    if (direction === 1 && !pending) {
      const state: WizardStepState = !skipped && doneNow[id] ? "done" : stepState(onboarding!, id) === "done" ? "done" : "skip";
      record({ [id]: state });
    }
    // A key or model picked for an agent that already exists is written now.
    if (direction === 1 && agent && (id === "provider" || id === "model") && !skipped) {
      try {
        await applyToExisting();
      } catch (err) {
        setError(getUserErrorMessage(err, t("settings.tab.saveFailed")));
        return;
      }
    }
    setError(null);
    if (direction === 1 && index === WIZARD_STEP_IDS.length - 1) setPhase("final");
    else setIndex((i) => Math.max(0, Math.min(WIZARD_STEP_IDS.length - 1, i + direction)));
  };

  const goTo = (target: WizardStepId) => {
    setError(null);
    setIndex(WIZARD_STEP_IDS.indexOf(target));
  };

  const dashboard = scope.orgSlug ? orgPath(scope.orgSlug) : "/";
  const channelsLink =
    agent && scope.orgSlug && scope.workspaceSlug
      ? workspacePath(scope.orgSlug, scope.workspaceSlug, `/instances/${encodeURIComponent(agent.slug)}?tab=channels`)
      : dashboard;

  /** Steps left unrecorded count as skipped; a finished record is `done` only when every step is. */
  const closingSteps = () => {
    const steps: Partial<Record<WizardStepId, WizardStepState>> = {};
    for (const step of WIZARD_STEP_IDS) {
      if (stepState(onboarding!, step) === "todo") steps[step] = doneNow[step] ? "done" : "skip";
    }
    return steps;
  };

  const leave = (patch: OnboardingPatch) => {
    setConfirm(null);
    finishWizard(patch);
    router.push(dashboard);
  };

  const finish = () => {
    const steps = closingSteps();
    const all = WIZARD_STEP_IDS.every((s) => (steps[s] ?? stepState(onboarding!, s)) === "done");
    leave({ wizard: all ? "done" : "skipped", steps });
  };

  const stepProps: StepProps = {
    draft,
    patchDraft,
    models,
    modelsFailed,
    agent,
    agentOptions,
    pickAgent,
    busy,
    error,
    goTo,
    onCreateAgent,
    web,
    channelsLink,
    onToggleWeb,
    onToggleAuth,
    onRegenerateKey,
    chat: { lines, sending, keyInput, setKeyInput, send: sendChat },
    kb: { title: kbTitle, text: kbText, added: kbAdded, setTitle: setKbTitle, setText: setKbText, add: addKnowledge },
  };

  const status = useMemo(
    () => (sid: WizardStepId): WizardStepState => (doneNow[sid] && sid !== "welcome" ? "done" : stepState(onboarding!, sid)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onboarding, applied, agent, web.enabled, lines, kbAdded],
  );

  if (!onboarding) return null;
  const last = index === WIZARD_STEP_IDS.length - 1;

  return (
    <>
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            setConfirm("skipAll");
          }}
          onInteractOutside={(e) => e.preventDefault()}
          className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">{t("onboarding.wizard.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("onboarding.wizard.description")}</DialogDescription>

          <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6">
            <div>
              <p className="text-sm font-semibold">{t("onboarding.wizard.title")}</p>
              {phase === "steps" && (
                <p className="text-xs text-muted-foreground">
                  {t("onboarding.wizard.progress", { current: index + 1, total: WIZARD_STEP_IDS.length })}
                  {" · "}
                  {t(`onboarding.step.${id}.title`)}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirm("never")}>
                {t("onboarding.never")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirm("skipAll")}>
                {t("onboarding.wizard.skipAll")}
              </Button>
            </div>
          </header>

          {phase === "final" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <h2 className="text-2xl font-semibold tracking-tight">{t("onboarding.wizard.finalTitle")}</h2>
              <p className="max-w-md text-muted-foreground">{t("onboarding.wizard.finalBody")}</p>
              <Button onClick={finish}>{t("onboarding.wizard.finalGo")}</Button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <nav aria-label={t("onboarding.wizard.title")} className="hidden w-64 shrink-0 overflow-y-auto border-r p-4 md:block">
                <ol className="space-y-1">
                  {WIZARD_STEP_IDS.map((sid, i) => {
                    const st = status(sid);
                    return (
                      <li key={sid}>
                        <button
                          type="button"
                          aria-current={i === index ? "step" : undefined}
                          onClick={() => goTo(sid)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent/60",
                            i === index && "bg-accent font-medium",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                              st === "done" && "border-primary bg-primary text-primary-foreground",
                            )}
                          >
                            {st === "done" ? <Check className="size-3" /> : st === "skip" ? <Minus className="size-3" /> : i + 1}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate">{t(`onboarding.step.${sid}.title`)}</span>
                            <span className="block truncate text-xs font-normal text-muted-foreground">
                              {t(`onboarding.step.${sid}.subtitle`)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>
              <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-8">
                <div className="mx-auto max-w-3xl">
                  <WizardStepBody id={id} p={stepProps} />
                </div>
              </main>
            </div>
          )}

          {phase === "steps" && (
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 sm:px-6">
              <Button variant="ghost" onClick={() => void leaveStep(-1)} disabled={index === 0}>
                {t("common.back")}
              </Button>
              <div className="flex flex-wrap gap-2">
                {id !== "welcome" && (
                  <Button variant="outline" onClick={() => void leaveStep(1, true)}>
                    {t("onboarding.wizard.skipStep")}
                  </Button>
                )}
                <Button onClick={() => void leaveStep(1)} disabled={busy}>
                  {last ? t("onboarding.wizard.finish") : t("common.continue")}
                </Button>
              </div>
            </footer>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent className="z-[210]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "never" ? t("onboarding.never.title") : t("onboarding.skipAll.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "never" ? t("onboarding.never.body") : t("onboarding.skipAll.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("onboarding.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirm === "never"
                  ? leave({ wizard: "dismissed" })
                  : leave({ wizard: "skipped", steps: closingSteps() })
              }
            >
              {confirm === "never" ? t("onboarding.never.confirm") : t("onboarding.skipAll.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
