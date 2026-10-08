---
name: engineering-checkpoint
description: Use once when a final diff is ready for a PR, after a merged PR needs ecosystem follow-through, or for a bounded weekly maintenance review.
---

# Engineering checkpoint

This is a completion step, not another implementation loop. Read
`docs/engineering-checkpoints.md` for cadence and evidence. Claude Code, Codex and
human contributors use the same commands; no provider, hook or agent CLI is required.

1. Pin the base and head; run `npm run engineering:check -- --base <base-ref>`.
   The path signals select inspections, not automatic findings. Read behavior too.
2. Execute the relevant existing checks. New request shapes need real HTTP;
   changed UI flows need browser evidence. Record environmental blockers honestly.
3. Review this diff once for correctness and simplicity: duplicated ownership,
   avoidable dependencies/abstractions, dead code, hidden errors and tests that only
   repeat the implementation. For changed tests, apply `.claude/rules/tests.md` once.
   Resolve concrete findings or name the remaining debt.
4. If a concrete correction or escaped defect arose, follow `docs/engineering-checkpoints.md`
   § Lessons from work once. Record the example, chosen mechanism and focused proof
   in the existing maintainability evidence; keep ordinary task preferences in the PR.
5. Decide each affected configuration's export/import, snapshot, migration,
   role defaults, authorization, audit and retention behavior. Prefer existing
   derived guardrails; verify fallback tests isolate the path under examination.
   Added/changed features, especially configuration/options, also require a Status
   coverage decision using the existing checks: see § Collateral impact in the guide.
   Apply only triggered rows of § Lifecycle and deployment; reuse relevant proof.
6. Record SDK, CLI, dev-kit and docs as updated (link the work), follow-up required
   (link the tracked work and compatibility limit), or no-impact (reason).
   Public contract breaks block release until consumers and docs are compatible.
   Added/changed user-visible features require the relevant usage guide; channel
   changes also require the setup guide and contextual UI link described in
   `docs/engineering-checkpoints.md` § Collateral impact.
7. Fill the PR template in English for the exact head. CI checks completeness;
   it cannot certify the reviewer's judgment. On new commits update only invalidated
   evidence. On body edits run no implementation or full review again.

After merge, confirm linked component work and the integration target once; reuse
the report. Documentation follow-ups do not restart product implementation. Weekly,
compare inventory artifacts and review outstanding exceptions/failed checks for at
most 30 minutes; propose at most three evidenced items, do not start a refactor fleet.
