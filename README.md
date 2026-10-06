# Stratosteel OS

Template of a company operated by AI workers under human gates, in six layers. Built by Stratosteel s.r.o. for itself first (the MVP), designed from day one so that a second company installs it by configuration, not by rewriting. Direction and canon live in the private knowledge repository `stratosteel/stratosteel` (`00_CORE/STRATOSPHERE_GLOBAL_THESIS.md`, `02_PROGRAMS/P1_BACKBONE/STRATOSTEEL_OS_ARCHITECTURE.md`, `STATE_OF_THE_BUILD.md`). This repository is the code and the template; it carries no company secrets, no customer or partner names and no credentials.

Status 2026-10-06: v0.1.0, skeleton. 11 MCP tools over mock providers, policy as code, append-only ledger and approval queue, manifest validator, 21 tests passing, stdio server verified with an MCP client handshake. No real tenant, record system or runtime is wired yet (that is what the gates below measure).

## The six layers

| Layer | Purpose | Provider options | In this repo |
|---|---|---|---|
| L1 tenant | identity, mail, files, chat for people and workers | Microsoft 365 Business, Google Workspace | `MailProvider`, `FilesProvider` interfaces; mock |
| L2 records | system of record: inquiry (DOP) -> supplier RFQ (RFQ_OUT) -> quote (CN) -> order (PO), sourcing plan | FABRIX, Odoo | `RecordsProvider` interface; mock with a worked steel-structure job |
| L3 runtime | where AI workers run, with permissions, schedules, budgets | Claude Managed Agents, XS FORGE | manifest field, budget cap; adapters later |
| L4 memory | durable canon, decisions, append-only handover ledger, state page | GitHub | `ledger.ts`, `MemoryProvider`; file-backed implementation |
| L5 access | one door for every AI to mail, files, records, memory | MCP (this server) | `src/server.ts`, `src/tools.ts` |
| L6 gates | what AI may do alone, what a person approves, what is forbidden | policy as code | `src/policy.ts`, `src/approvals.ts` |

## Tree

```
layers.yaml            manifest: provider per layer, six MVP gates (validated by src/manifest.ts)
src/policy.ts          autonomy policy: allow / ask / deny with reasons, quiet hours, drawing checks, confidential names, disclosure
src/approvals.ts       approval queue, append-only JSONL events, one decision per request
src/ledger.ts          handover ledger lines "YYYY-MM-DD HH:MM TZ | from | to | task | status | evidence", append only
src/providers.ts       interfaces for mail, files, records, memory
src/mock.ts            mock providers over generic fixtures (reference behaviour for real providers)
src/tools.ts           the 12 tool definitions (11 for agents, approval_decide for people)
src/server.ts          MCP server wiring (SDK v2), context from environment
src/index.ts           stdio entrypoint
src/manifest.ts        layers.yaml schema and gate-order check
test/                  node:test suites (policy, ledger, approvals, server flow, manifest)
docs/LAYERS.md         each layer: purpose, interface, acceptance, current Stratosteel choice
docs/ADOPTION.md       how a second company installs the template by configuration only
ROADMAP.md             gates G1-G6, mapping to acceptance tests A01-A15 and T1-T9, next steps
.github/workflows/ci.yml  build, test, manifest check on every push
```

## Quick start

```bash
npm ci
npm test                     # build + 21 tests
npm run lint:manifest        # validates layers.yaml and the gate order
OS_CALLER=worker-1 OS_ROLE=agent node dist/src/index.js      # MCP server on stdio, mock providers
OS_CALLER="M. Example" OS_ROLE=human node dist/src/index.js  # a person's client: approval_decide is mounted
```

Configuration is by environment only: `OS_CALLER` (who is connected), `OS_ROLE` (`agent` or `human`), `OS_STATE` (local state directory for `approvals.jsonl` and the local ledger), `OS_STATE_PAGE` (path of the state page for `state_of_build`). Credentials for real providers will come from the host's secret store (Keychain, tenant managed identity, GitHub Actions secrets), never from this repository.

## Tools (layer 5)

`search_mail`, `get_message`, `search_files`, `get_job`, `list_jobs`, `ledger_append`, `ledger_tail`, `state_of_build`, `policy_check`, `approval_request`, `approval_list`; and `approval_decide` for people only. A worker calls `policy_check` before every external step; `ask` means it files `approval_request` and stops; a person decides in their own client; the result goes to the ledger.

Connect from a client (Claude Desktop, Claude Code, Codex, ChatGPT Business developer mode): command `node`, args `dist/src/index.js`, env as above. Same tools, same policy, same records for every model.

## Rules this code enforces (from the owner's autonomy policy, 2026-10-06)

1. Reads are always allowed. Drafts and internal notes from L1. L0 observes only.
2. At L2 a worker acts alone only for supplier inquiries and follow-ups, inside an approved template, with the counterparty and recipient in the register, and discloses that it is an AI.
3. Customer quotes, prices, orders, contracts, new counterparties and unknown recipients always go to a person. L3 external autonomy is not enabled.
4. Denied, whatever the level: external sending in quiet hours (00:00 to 06:00 local by default), a drawing with fewer than 3 checks, any confidential name in external text.
5. Approvals are decided once, by a named person, in a human client; a worker cannot mount the deciding tool.
6. The ledger is append only; every line carries evidence; typographic dashes are rejected.

## What is not here on purpose

Company names, addresses, registers, templates, prices, partner names, mail content, credentials. They live in the company's own instance configuration and tenant. The template must run with mock providers for anyone, and must install into a second company without a code change (gate G6).
