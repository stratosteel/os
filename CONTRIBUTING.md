# Contributing

This repository is a template built in the open by one company for itself first, under a source-available proprietary licence (see LICENSE). The most useful contribution is a precise failure: "layer N breaks for a company like mine because X", as an issue. Code contributions need a short written agreement first (the licence does not yet grant redistribution rights); open an issue and we will sort it out.

## Rules
1. Evidence over claims. A statement about behaviour comes with a test or a log; a claim about an outcome comes with the number.
2. No company data. No names of customers, partners or people, no prices, no mail content, no credentials, in code, fixtures, tests or issues. Fixtures stay generic.
3. One subject per issue. Small and precise beats large and impressive.
4. Hyphens, not typographic dashes, in text that lands in the ledger (the ledger rejects them).
5. The autonomy policy (layer 6) is the owner's decision for the first instance. Propose changes as a configuration for a second instance, not as a change to the default, unless you can show the default is unsafe.

## How to run
See the Quick start in README.md: `npm ci`, `npm test`, `npm run lint:manifest`, then the stdio server with mock providers.

## Issue templates (free text is fine)
- Design critique: layer, expected failure, the company size and sector it fails for, what you would do instead.
- Provider proposal: which interface, which product, what the adapter must guarantee, how you would test it without company data.
