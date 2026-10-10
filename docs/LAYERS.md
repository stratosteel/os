# The six layers: purpose, interface, acceptance, current Stratosteel choice

Design source: `stratosteel/stratosteel/02_PROGRAMS/P1_BACKBONE/STRATOSTEEL_OS_ARCHITECTURE.md` (section 3 layers, section 4 autonomy policy, section 5 worked steel-structure flow, section 7 runtime gate, section 11 product direction). This file describes what each layer must provide to the template; it does not repeat the plan or the specification.

## L1 tenant: identity, mail, files, chat

Purpose: one organisational home for people and workers: user identities, shared mailboxes (rfq@, office@, archiv@ as the audit copy), document libraries synced to every computer, team chat. Everything a colleague's AI needs to find "who sent what to whom and when" with the exact attachment.
Interface in the template: `MailProvider` (search, read), `FilesProvider` (search); write paths (send, upload) belong to workers with a service identity and a send record, never to chat assistants.
Acceptance: the instance plan's T1-T9 (DNS, delivery, archive copy, shared libraries, connector reads, retrieval of an exact mail and attachment by a third person's AI).
Options: Microsoft 365 Business (Exchange, SharePoint, OneDrive, Entra, Teams); Google Workspace (Gmail, Drive, Groups). Stratosteel choice 2026-10-06: Microsoft 365 Business Basic x3, Google Workspace as the falsifiable second option (three criteria at day 30).

## L2 records: the system of record

Purpose: one chain per job: inquiry DOP -> supplier requests RFQ_OUT -> quote CN -> order PO, with documents, revisions, approvals and the sourcing plan ("where to order what" decided at quoting, executed at order). No second truth in mail folders or chat.
Interface: `RecordsProvider` (`getJob`, `listJobs`); later `createChild`, `setSourcingPlan`, `recordDecision`.
Acceptance: A01-A15 of the functional specification (ASTRA), in particular A03 (exact retrieval), A05 (two workers, one intended send), A09 (timeout, restart and reconciliation before any retry), A11 (a changed drawing invalidates the approval).
Options: FABRIX (Stratosteel's own, live with document chain and audit); Odoo as the OPPOSITE test. Stratosteel choice: FABRIX, Odoo tested against it.

## L3 runtime: where workers run

Purpose: AI workers that execute workflows unattended inside the policy: permissions per tool, scheduled runs, budgets, pause for approval, resume on decision, full logs.
Interface: a runtime adapter that maps the runtime's permission model to `policy_check` and `approval_request`; budget cap from the manifest (`budget_usd_cap`).
Acceptance: a worker completes one real supplier inquiry with a send record and stops correctly on `ask`; cost under the cap; restart and duplicate-event handling proven.
Options: Claude Managed Agents (beta: permission policies always_allow, always_ask, auto with pause for approval, webhooks, scheduled deployments, self-hosted sandboxes); XS FORGE (own task, event, lease, retry substrate); no runtime (humans run the tools through their clients). Stratosteel choice: decided by the three-stream gate in architecture section 7; EXECUTION default Managed Agents pilot with a USD 150 cap.

## L4 memory: canon, decisions, ledger, state page

Purpose: durable knowledge and the only durable handover channel between AIs and people: canonical files, the append-only ledger, the living state page. Chat is transport, not memory.
Interface: `MemoryProvider` (`appendLedger`, `readLedgerTail`, `readStatePage`); ledger format enforced by `ledger.ts`.
Acceptance: two AIs from different vendors complete a handover round through the ledger without a person relaying (proven in Stratosteel 2026-10-06); a cold-started agent reconstructs context from the repository alone.
Options: GitHub (chosen; private repositories, history, Issues for bounded live work). Stratosteel choice: `stratosteel/stratosteel`.

## L5 access: one door for every AI

Purpose: every model and client (Claude Desktop and Code, Codex, ChatGPT, workers) reaches mail, files, records and memory through one MCP server, so the policy, the records and the audit are the same whatever the vendor. Vendor independence lives here.
Interface: the tools in `src/tools.ts`; stdio transport first, HTTP later for hosted workers.
Acceptance: the same question answered identically from two different clients; `approval_decide` never reachable from an agent client; every tool call attributable to a configured caller.
Options: MCP (chosen); vendor connectors as a stop-gap for reads (Claude's Microsoft 365 connector reads shared mailboxes read-only).

## L6 gates: what AI may do alone

Purpose: the owner's policy as code: AI operates and clicks; people approve templates and numbers, not operations. Reads free; drafts from L1; L2 autonomous only for supplier inquiries and follow-ups inside approved templates and the register; quotes, prices, orders, contracts, new counterparties and unknown recipients always to a person; quiet hours, drawing checks and confidential names denied outright; disclosure on every autonomous external message (Art. 50 AI Act).
Interface: `decide()` in `src/policy.ts`, `ApprovalQueue` in `src/approvals.ts`; instance overrides from yaml (names, quiet hours, scope).
Acceptance: the policy tests (13) pass; one real approval round (worker asks, person decides in their own client, ledger line written) in production; an attempted L3 action is refused.
Stratosteel choice: defaults in `DEFAULT_POLICY`; the lawyer confirms the disclosure wording before the first worker send.
