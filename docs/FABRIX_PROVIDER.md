# FABRIX provider (layer 2)

FABRIX is the system of record in Stratosteel's instance of this template. This provider wraps its
`/api/v1` so AI workers reach records through the same door as everything else.

## What it is
- `FabrixClient`: `read(verb, params)` and `write(verb, input, idempotencyKey?)` over HTTP with the
  worker's own access token as `Authorization: Bearer`. FABRIX makes the request as that account, so
  its row level security and its gates apply to the worker as to a person.
- `FabrixRecordsProvider`: `getJob` and `listJobs` (the generic `RecordsProvider`). A job is keyed by
  its job code; a supplier appears as a reference, never by name.
- `fabrix_*` tools (`src/fabrix_tools.ts`), mounted only when `providers.fabrix` is set.

## Gates
`policy_check` still comes first. FABRIX then enforces its own rules again: a number goes out only
with an approved approval of exactly that content, a counterparty must be approved, a drawing must
have passed its checks and an NDA must be valid, a supplier answer needs a source. `decide_approval`
and `approve_counterparty` do not exist for a worker account; a person does them in their own client.

## Configuration
```ts
import { FabrixClient, FabrixRecordsProvider } from './providers/fabrix.js';
const client = new FabrixClient({ baseUrl: process.env.FABRIX_URL!, getToken: async () => readWorkerToken() });
const providers = { ...otherProviders, records: new FabrixRecordsProvider(client), fabrix: client };
```
The token lives in the worker's secret store (Keychain), never in a file of this repository.
