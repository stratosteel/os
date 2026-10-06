# Installing the template in a second company (gate G6, by configuration only)

This is the promise the template must keep: a second company gets an AI-operated back office by filling configuration, not by changing code. Until gate G6 is passed in Stratosteel, this file is the specification of that promise, not a report of it.

## What the second company provides

1. A tenant (Microsoft 365 Business or Google Workspace) with three shared mailboxes (inquiries, office, archive copy) and the document libraries named in `layers.yaml`.
2. A system of record (FABRIX or Odoo) with the job chain inquiry -> supplier requests -> quote -> order, or the willingness to start with the template's record model.
3. A private GitHub repository for canon, ledger and state page, created from the knowledge template (`STRATOSTEEL_HUB.md`, `STATE_OF_THE_BUILD.md`, `02_PROGRAMS/HANDOVER_LEDGER.md` as empty shells).
4. Named people for the gates: who approves templates, who approves prices and quotes, who approves orders and contracts, who adds a counterparty to the register.
5. Its own values for the instance file (below). Never the template's.

## The instance file `<company>.instance.yaml`

Overrides `layers.yaml` without changing the layer set or the gate semantics:

```yaml
schema: stratosteel-os/layers/v0.1
company: { id: second-co, name: Second Company Ltd, timezone: Europe/Vienna, languages: [de, en] }
layers:
  L1_tenant:  { provider: m365, status: live }
  L2_records: { provider: odoo, status: live }
  L3_runtime: { provider: managed-agents, budget_usd_cap: 100, status: building }
  L4_memory:  { provider: github, repo: second-co/knowledge, ledger_path: 02_PROGRAMS/HANDOVER_LEDGER.md, state_page: STATE_OF_THE_BUILD.md, status: live }
  L5_access:  { provider: mcp, transport: stdio, status: live }
  L6_gates:
    policy: policy/default
    overrides:
      confidentialNames: [ ... its partners and suppliers ... ]
      quietHours: { start: "22:00", end: "06:00" }
      l2Autonomous: [supplier_inquiry, supplier_followup]
```

## Install check (to be implemented before G6)

`npm run install-check -- second-co.instance.yaml` must: validate the manifest and the gate order; connect each configured provider read-only and run one search; verify that `approval_decide` is unreachable from an agent client; write and read one ledger line; print the six-layer status table. Green means the second instance exists; the company's workers then start at L1 (drafts) and earn L2 per workflow after template approval, exactly as in Stratosteel.

## What the offer contains (owner direction 2026-10-06)

The template with the operating team that installs it, writes the first templates with the company's people, runs the first weeks at L1, and hands over L2 workflows with their send records and ledger. The template alone, without the team and the human gates, is not the product.
