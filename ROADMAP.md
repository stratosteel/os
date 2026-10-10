# Roadmap: from skeleton to the Stratosteel MVP and the first second instance

Gates are measured in `stratosteel/stratosteel/STATE_OF_THE_BUILD.md`; this file says what the code must do for each gate. Acceptance tests A01-A15 are ASTRA's functional tests (`SHARED_OPERATIONS_REQUIREMENTS_2026-10-06.md`), T1-T9 are the layer 1 cutover tests (`POSTA_A_WORKSPACE_PLAN_2026-10-06.md`); both in the knowledge repository, not copied here.

| Gate | Meaning | Code needed in this repository | Depends on |
|---|---|---|---|
| G1 | layer 1 live, T1-T9 pass | nothing (tenant work); `layers.yaml` L1 provider set to m365, status live | owner creates the tenant; DNS access |
| G2 | first thin slice A03 without new code (quote rev 3 prepared by one person, sent by another, retrieved by a third person's AI with the exact mail and attachment) | nothing; proves the shared store before code | G1, MX cutover |
| G3 | first worker supplier inquiry with a send record (A05 two workers, one intended send (idempotent send intent); A09 timeout, restart and reconciliation before any retry; A11 a changed drawing (new revision or changed bytes under the same filename) invalidates the approval) | `providers/m365.ts` (Graph: search mail, read message, search files; send only through the worker's service identity with a send record), `send_record.ts`, runtime adapter for Claude Managed Agents (permission policy maps to `policy_check`), approval webhook handler. State 2026-10-10: coded against a fake transport only: `send_record.ts` (persisted send intent, fenced claim, durable attempt history), `send_dispatcher.ts` (reconciliation before any retry, escalation instead of a resend, policy recheck at dispatch), `transport.ts` (`SendTransport`, file-backed `FakeTransport` with the failure matrix); the A05 and A09 fault-injection tests pass on that fake. Remaining: A11 approval binding and A10 scoped access (stacked branch), `providers/m365.ts`, the runtime adapter, the replay against the real adapter in a controlled tenant and the first authorized send record. G3 is NOT passed: mock tests prove only their modeled semantics | G1, D3 (runtime pilot), lawyer's disclosure wording |
| G4 | two automatic handover cycles ATLAS x ASTRA without the owner | `providers/github.ts` (ledger append through the GitHub API, state page read), bus adapter reusing the XS coordination pattern (immutable messages, STATUS rebuild, loop guard fail-closed) | xs-lab loop_guard PR merged |
| G5 | one full steel-structure flow inquiry -> supplier RFQs -> sourcing plan -> quote -> order inside the system | `providers/fabrix.ts` (jobs, children, sourcing plan) or `providers/odoo.ts` as the OPPOSITE test; quote assembly helper; order routing ("where to order what") from the sourcing plan | G3, FABRIX schema decision |
| G6 | template installed into an empty second instance by configuration only | instance loader (`<company>.instance.yaml` over `layers.yaml`), policy overrides from yaml, provider factory by manifest, install check script | G5 |

Gates pass in the order of the Depends on column, not in number order (`gateOrderErrors` in `src/manifest.ts` checks the same dependencies): G4 does not depend on G3; the metadata-only G4 bus proof may pass before mail cutover and G3, and it must precede unattended worker activation. G5 depends on G3, G6 on G5.

## Next steps in order (owner of the code: GM ATLAS with Codex workers; reviewer: ASTRA on evidence)

1. Instance file loader and policy overrides from yaml (confidential names, quiet hours, L2 scope) with tests. No tenant needed.
2. `providers/github.ts`: ledger append and tail against `stratosteel/stratosteel` with a fine-grained token held outside the repository; test against a scratch repository.
3. Send record model and A05/A09/A11 tests with a fake transport; the real transport only after G1. State 2026-10-10: the send record model with a file-backed fake transport is coded, and the A05 tests (two worker processes, barrier race, duplicate event, lease expiry under SIGSTOP) and A09 tests (failure matrix, SIGKILL between the provider's answer and the record write, bounded reconciliation) pass on it, with persisted evidence (branch `feat/g3-send-record-a05-a09`). Open: A11 and A10 (stacked branch `feat/g3-approval-binding-a11-a10`); a provider-side fence or proven deduplication to close the residual window (a worker stopped after its last fence check still submits once on resume; draft-first sending is the candidate to test); the real transport and its classification of failures, proven per endpoint in a controlled tenant.
4. `providers/m365.ts` read paths (Graph search mail and files) once the tenant exists; write paths only through the worker service identity.
5. Runtime adapter for Claude Managed Agents: map `always_ask` permission policies to `policy_check` results; approval pause -> `approval_request`; resume on `approval_decide`.
6. Records provider (FABRIX first; Odoo as the OPPOSITE test) with the sourcing plan.
7. Install check: `npm run install-check -- <company>.instance.yaml` proves G6 on an empty configuration.

## Non-goals until G6

A user interface beyond the clients' own (Claude, Codex, ChatGPT, Teams); multi-tenant hosting; billing; any public offer. The product is sold as execution with the template, after the Stratosteel MVP, never before.
