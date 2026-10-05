# Engineering checkpoints

One final checkpoint per PR connects normal implementation to ecosystem upkeep.
Use `npm run engineering:check -- --base origin/develop`. It prints change impacts;
it inspects the committed diff and does not execute unrelated suites or invoke models. The PR's evidence names
the full reviewed head SHA. A later commit requires refreshing only affected proof.

| Moment | Required result | Bound |
|---|---|---|
| Start | Correct repo/base, shared or edition-specific scope, likely impacts | One classification |
| Implementation | Existing focused checks and observable regression proof | Changed behavior only |
| PR ready | Single simplicity review, collateral checks, four ecosystem decisions | Final diff once |
| After merge | Confirm linked updates and integration destination | Reuse PR evidence |
| Release | Full candidate-range audit, compatibility, security and performance | Pinned candidate SHAs |
| Weekly | Inventory trends and unresolved debt; at most three proposed actions | 30 minutes, no auto-fix loop |

The Engineering evidence job checks the PR body's completeness and freshness. It
does not certify prose claims. Existing product tests, security scans and a reviewer
provide independent evidence. Required checks must be configured in GitHub rulesets;
the presence of a workflow alone does not prevent a merge. Drafts may remain red
until the completion checkpoint. Write PR titles/descriptions/reviews in English
and sign commits with DCO. Release promotion also needs a completed checkpoint.

## Lessons from work

Keep a concrete agent correction or escaped defect in the current task notes/PR:
what happened, expected behavior and the observed example. At the final checkpoint,
check current code, instructions and enforcement before adding anything. Reuse an
existing mechanism where it already covers the failure. Repeated gaps and serious
first failures warrant a durable fix; task-specific preferences stay in the PR.

| Lesson | Owning mechanism |
|---|---|
| Incorrect product behavior | Code and observable regression test |
| Constraint that must hold for every contributor | Existing test, lint, script or CI gate |
| Missing procedure | Existing task skill |
| Procedure exists but was missed | Skill description or conditional instruction pointer |
| Repository-wide working agreement | CLAUDE.md |
| Durable architectural choice | ADR |

Record the example, chosen mechanism and verification in the existing
maintainability evidence. Replace superseded guidance and check for duplication.
For changed skill behavior, exercise one relevant task with independent success
criteria; file/link tests prove discovery consistency, not agent compliance.
Deferred fixes link tracked work and the remaining consequence. Weekly review
collects recurring unresolved lessons within the existing time/action bound.
Do not rescan all transcripts or launch a new review on every correction.

When adding or renaming a skill, edit the canonical `.claude/skills/<name>/SKILL.md`
and run `npm run skills:sync`. It creates missing relative Codex links, is repeatable,
and refuses conflicting copies/targets. Obsolete entries are reported with a failing
exit status for explicit review; the command never deletes or overwrites them.
The existing CI entrypoint test rejects missing, obsolete, copied or incorrect links.
Commit the skill and its link changes in the same PR. Removing a skill requires
removing its obsolete link after confirming the intended deletion.

## Collateral impact

For configuration/schema changes decide export/import, snapshot, defaults, upgrade
and purge behavior. Use inventories derived from schema/route metadata; an explicit
exclusion is a decision with a reason, not an omitted test. For permissions verify
old installations and newly created tenants, allowed and denied roles, and audit
effects. Route changes require current generated API artifacts and proxy coverage.

For supported locales check key parity, duplicate keys, interpolation placeholders,
retired copy and the changed UI in both languages. Dynamic keys cannot safely be
deleted by an unused-key grep. Translation quality and removing a supported language
are editorial decisions, not automatic repairs.

Every PR records SDK, CLI, dev-kit and docs impact, even when no change is needed.
Adding or changing a user-visible feature requires updating the relevant product
guide in the docs repository, including usage, options, defaults and limitations
that changed. Update API references, README or upgrade notes where affected.
Link the corresponding docs work in the PR and verify documentation publication
before releasing the feature; a changelog entry alone is not a usage guide.

For an added or changed channel, update its setup guide and the contextual docs
link in the channel configuration UI. Explain prerequisites, required permissions,
where to obtain each identifier/credential, webhook or callback setup, and how to
verify the connection. Use safe examples. Reuse the current documentation-link
helper when present; verify the destination page/anchor and keep it aligned with
the configuration fields. A generic documentation homepage is insufficient.

Contract changes inspect consumers' installed tags, not just local manifest versions.
Follow-ups name related work and the compatibility consequence. A source change
does not mean every component must receive a new version.

## Measures and baseline

`npm run engineering:inventory` records the head, test/guardrail file counts and
locale gaps. Weekly artifacts retain 30 days. These counts are inventory, not a
quality score. Assess executed tests, skips/flakes, regressions/reverts, outstanding
exceptions, stale consumer pins and human interventions; use evidence from CI/PRs.
Performance compares the same scenario and resources against the previous release.
Coverage thresholds are existing ratchets, not arbitrary new targets.

After the checkpoints work, run a separate baseline pass: pin all repositories,
install their own lockfiles, run existing tests/builds and drift checks, record
security/performance evidence and classify existing findings. Fix agreed issues
through ordinary PRs. Record outstanding exceptions rather than weakening controls
to manufacture a green baseline. Do not run this pass on every small feature.

## Release coordination

Read the release skill. Pin each affected component's candidate SHA, independent
version, last released tag, consumer refs and publishing destination. Reuse existing
preparation scripts and the docs repository's sync procedures. Required outcomes:

- Changelog, README, upgrade notes, configuration examples and API references agree.
- SDK/protocol and CLI/dev-kit consumers are tested against the intended engine.
- Full release-range security review includes dependencies and changed boundaries.
- Performance evidence uses a repeatable baseline; missing evidence is a blocker
  for a release affecting the measured behavior, not an invitation to invent numbers.
- Each component is published at its own version or explicitly unchanged/compatible.
- Publication records exact tag/commit, GitHub Release or package/site artifact;
  verify consumer installation and documentation after publication.

Publishing is not atomic across repositories. Record completed steps so a retry
verifies existing tags/artifacts and resumes without replacing tags or republishing.
Keep private/internal material out of public components. Final publication authority
comes from the release request and the owning repository's instructions.

The release manifest is a scratch artifact, not a second version registry. Run
`npm run release:ecosystem -- /path/to/release.json`. Include one entry per
`product`, `sdk`, `cli`, `dev-kit` and `docs`; additional editions are allowed:

```json
{"components":[{"name":"product","path":"/checkout","sha":"<40-character SHA>","previousTag":"v1.0.0","decision":"release","tag":"v1.1.0","destination":"GitHub tag and Release","evidence":"Tests and consumer compatibility verified on this SHA."}]}
```

Use `decision: "unchanged"` with a reason when no publication is needed. The
docs entry may omit a tag: publish its site/PDF from the pinned SHA and record
the destination and resulting artifact. Its npm package version is not the engine version.
The
script reads committed manifests at the pinned SHA and validates the baseline
ancestry; it never switches a checkout, executes its scripts or publishes. Its
consumer refs must be compared with the intended component tags. Components without version tags use `baseline` with an explicitly reviewed full
commit SHA (for a first release, the repository root commit). Never guess a
published baseline from the version field.
