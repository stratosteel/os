# STATUS (measured state of the template and of the first instance; rewritten in place, dated)

Last update: 2026-10-07. Owner of this page: the Stratosteel AI team (GM). Numbers only, with their source; UNK where nothing has been measured yet.

## MVP gates (template)
| Gate | Definition | State | Date or evidence |
|---|---|---|---|
| G1 | Layer 1 tenant live for the first instance (mail, files, identity) | not passed | tenant not created as of 2026-10-07 |
| G2 | Layer 2 records: inquiry to quote chain carried by the system of record | not passed | record system exists for the first instance; package and quotation tables UNK |
| G3 | Layer 3 runtime: one AI worker completes one real sourcing task under policy | not passed | pilot after G1 |
| G4 | Layer 4 memory: two AIs hand over work through the ledger without a person copying | not passed | 2 manual round trips on 2026-10-06; 0 automatic |
| G5 | Layer 5 access: the MCP server serves real providers, not mocks | not passed | 0 real providers wired |
| G6 | Second company installs by configuration only | not passed | after G5 |

## Measures of "operated by AI" (first instance)
| Measure | Baseline | Latest | Source |
|---|---|---|---|
| Human hours per qualified meaningful conversation | UNK, baseline window 2026-10-06 to 2026-10-19 | UNK | baseline log |
| Owner approval touches per week (templates, prices, orders, contracts, new counterparties) | UNK | UNK | approval queue |
| Worker sends with a send record | 0 | 0 | send records |
| Automatic handover cycles without the owner | 0 | 0 | ledger |

## Research sibling: XS Lab (private repository), narrowest audited claim
In a controlled synthetic document-routing environment with a fixed primitive catalog, a learned procedure kept 70/70 blind known-space accuracy with the pinned model claude-haiku-4-5-20251001 and used 43.6 % fewer logical model calls than the best human-built static procedure (48.0 % fewer tokens, 55.1 % lower cost). On a fresh operator-blind holdout of 30 tasks both real arms had 0/30 false stores (Wilson 95 % upper bound 11.3 %) and 3/30 unsafe reject-instead-of-human-review actions. Total spend 0.151691 USD. Independent audit verdict VALID (2026-09-30). This is not a production claim, not a general safety claim, and not evidence that the system invents capabilities it does not have.

## Change log of this page
- 2026-10-07: first public version.
- 2026-10-10: branch fix/astra-review-2026-10-07 (pull request to main) closes review findings OS-POL-01, OS-POL-02, OS-POL-03, OS-APP-01 and G3-MAP of 2026-10-07 in code and tests; no gate passed, G3 stays open.
- 2026-10-10: branch feat/g3-send-record-a05-a09 (pull request to fix/astra-review-2026-10-07) adds the send record layer (persisted send intent, fenced claim, durable attempt history, reconciliation before any retry, policy recheck at dispatch) with a file-backed fake transport and fault-injection tests for A05 and A09; mock semantics only, no real transport, 0 worker sends; no gate passed, G3 stays open.
