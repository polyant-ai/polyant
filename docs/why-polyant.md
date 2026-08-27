# Why Polyant

Where Polyant comes from, and the decisions that shaped it.

Polyant was conceived in the wake of the **OpenClaw** release. OpenClaw was a watershed moment for the agent ecosystem: it showed, in working code, what a reactive personal AI assistant could feel like and — more importantly — how to build the *harness* around the model: the loop, the tool dispatch, the message lifecycle, the guard rails. For the first time, the engineering pattern behind a serious assistant was readable, hackable, and reproducible outside a vendor-controlled platform.

We took OpenClaw apart, studied its design, and used it as the starting point for an analysis of what a multi-tenant, enterprise-grade evolution of that idea would need. Several technological choices in Polyant echo OpenClaw directly — the tool registry pattern, the supervisor-as-loop architecture, the markdown-driven skill system, the tier abstraction over models — because that vocabulary turned out to be the right one for this class of system.

From that foundation we set out to answer a different question: **what does it take to run this kind of assistant inside an organization?** The answer drove most of the layers you see today and pushed Polyant toward a web-based product rather than a CLI:

- A **multi-instance** model, so a single deployment can serve different assistants — each with its own personality, tools, secrets, and channels — without code branching.
- An **admin panel** as the primary surface, because the people who configure assistants in a company are not always the people who can edit a config file.
- **Per-instance encryption** of every secret (AES-256-GCM), so credentials for one assistant cannot leak into another tenant's blast radius.
- A **proactive Room engine** alongside the reactive chat loop, because real assistants do not only answer — they observe events and act.
- An **OpenAI-compatible API** as the default integration surface, so any client (Open WebUI, custom apps, scripts) can talk to any instance with zero adaptation.

Polyant is, in short, what happens when you take the architectural lessons of OpenClaw, hold them up against the requirements of building assistants that real teams can deploy, govern, and trust — and then ship the result as open source.

See also: [Architecture](https://docs.polyant.ai/concepts/architecture) for how these decisions are implemented, and [ROADMAP.md](../ROADMAP.md) for where they are heading.
