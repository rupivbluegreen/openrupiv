# Architecture Decision Records

Every settled decision gets an ADR. Decisions not written down are not
settled. Format:

```markdown
# NNNN — Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```

Numbering is sequential. An ADR is immutable once accepted; to change course,
write a new ADR that supersedes it and link both ways.

## Index

- [0001 — The LLM generates the spec; code is a deterministic projection](0001-llm-generates-spec-only.md)
- [0002 — Bundle Dex as the dev IdP in the Compose stack](0002-bundled-dev-idp.md)
- [0003 — OIDC-only authentication; no local auth](0003-oidc-only-no-local-auth.md)
- [0004 — Generated apps are declarative artifacts served by the runtime engine](0004-generated-apps-are-data-served-by-runtime.md)
- [0005 — Dev-mode role grant and second dev user](0005-dev-mode-role-grant.md)
- [0006 — Policy engine: OPA/Rego as embedded WASM, bundles pre-compiled and committed](0006-opa-wasm-embedded-pdp.md)
