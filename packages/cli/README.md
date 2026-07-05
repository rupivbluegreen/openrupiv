# @openrupiv/cli

The openRupiv command line: scaffold a workspace (`new`) and turn a
natural-language description into a running, reviewable app (`generate`).
Contract: `specs/phase-1-contracts.md` §4.

The LLM's only job is the **spec**; application code is a deterministic
projection by `@openrupiv/compiler` (ADR-0001), and the generated app is a
declarative artifact served by `@openrupiv/runtime` (ADR-0004). This CLI
orchestrates that pipeline and keeps change management PR-shaped: every
artifact it produces is committed to the workspace's git repository with
the user's own identity, DCO-signed.

## Running (v0 dev mode)

The CLI runs from the monorepo — it is not published yet. Either invoke it
directly:

```sh
corepack pnpm --filter @openrupiv/cli exec tsx src/main.ts new my-workspace
```

or through the bin wrapper (`bin/openrupiv.mjs` execs tsx on `src/main.ts`):

```sh
packages/cli/bin/openrupiv.mjs new my-workspace
```

## Commands

### `openrupiv new <name>`

Deterministic, offline scaffold — no network, no LLM. Creates `<name>/`:

| File | Purpose |
|---|---|
| `openrupiv.yaml` | workspace config (`specVersion: "0.1"`, `app: null` placeholder) |
| `README.md` | honest <10-minute quickstart for the workspace |
| `docker-compose.yaml` | postgres:16 (volume + healthcheck), Dex dev IdP, runtime built from the monorepo checkout |
| `dex/config.yaml` | DEV-ONLY Dex config: static client `openrupiv-local`, user `dev@example.com` / `dev-password` (bcrypt) |
| `.gitignore` | keeps `.env` out of the repo |
| `.env` | generated `SESSION_SECRET` + `OPENRUPIV_REPO` (compose build context); **gitignored** |

Then `git init -b main` and a DCO-signed initial commit. The only
non-deterministic byte is the generated session secret in the gitignored
`.env`.

All bundled identity credentials are development-only by design (ADR-0002)
and conspicuously marked; the runtime refuses the bundled client secret
unless `OPENRUPIV_DEV_MODE=true`. There is no password table anywhere —
Dex's static password store is the IdP's demo mechanism, and the runtime
only ever speaks OIDC (ADR-0003).

### `openrupiv generate "<description>" [--dir <workspace>] [--json]`

Pipeline: `generateSpec` (Anthropic model, ≤3 validated attempts) →
`validateSpec` re-check → `compileApp` → replace the workspace `./app`
directory → `git add -A && git commit -s` in the **workspace** repo.

- `--dir` — workspace directory (default: current directory; must contain
  `openrupiv.yaml` and a git repo).
- `--json` — stdout carries **exactly one** JSON object
  `{ ok, files, errors, attempts }` and nothing else; all human chatter
  goes to stderr. Errors are always `{ code, path, message }` — the same
  shape from the validator, the compiler, and the CLI itself.

Requires `ANTHROPIC_API_KEY` in the environment. The key is checked for
presence only — never written to disk, never echoed to any output (tested).

## Exit codes (contract)

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | generation/validation failed after the generator's retries |
| 3 | compile failed (includes `ERR_UNSUPPORTED_SECTION` for `policies`/`agents`/`evidence`) |
| 4 | environment error: missing `ANTHROPIC_API_KEY`, not a workspace, git failure, generator unavailable |
| 1 | usage error (unknown command/flag) or unexpected internal error — never used for the outcomes above |

## Design for testability

Commands are functions of `(arguments, CliDeps)` — the `CliDeps` seam
injects cwd, env, stdout/stderr writers, the git runner, randomness, the
compiler, the validator, and a loader for the generator module. `main.ts`
binds the real world; tests bind fakes plus real git and a real temp
filesystem. The generator is consumed strictly through its §3 contract
(`src/generator-contract.ts`) and verified at load time: a module that
does not implement the contract is a typed `ERR_GENERATOR_UNAVAILABLE`
environment error, never a silent no-op.

## Tests

```sh
corepack pnpm --filter @openrupiv/cli test
```

No network, no Docker, no `ANTHROPIC_API_KEY`: the suite runs `new` and
`generate` against real temp directories with real git, replays
`fixtures.vendorOnboardingSpec` through a contract-faithful fake generator
module, uses the real `@openrupiv/compiler`, asserts every contract exit
code, validates the emitted Compose/Dex YAML structurally, and includes an
end-to-end spawn of the tsx bin wrapper. A canary API key value asserts
the key never leaks into output.
