# 0001 — The LLM generates the spec; code is a deterministic projection

- Status: accepted
- Date: 2026-07-06

## Context

PLAN.md pillar 2 says `openrupiv generate` emits "a reviewable declarative
spec + generated code" into Git, and §3.2 says "the spec is the contract; UI
and runtime are projections of it." Those two statements admit two very
different architectures:

1. The LLM free-writes both the spec and the application code.
2. The LLM produces only the spec; a deterministic compiler projects the spec
   into code.

Option 1 makes three commitments unenforceable: golden tests (LLM code output
is not snapshot-stable), the human security-review budget (every generated
app would be novel code on security-relevant paths), and the <10-minute
time-to-first-running-app p50 (free-form code fails to build or run at some
rate that is not controllable).

## Decision

The LLM surface ends at the spec. `openrupiv generate`:

1. Calls the model to produce a **spec** conforming to the versioned app spec
   schema (validated, retried on schema violation).
2. Runs a **deterministic compiler** that projects the spec into readable
   application code, tests, and migrations. Same spec in → byte-identical
   output, guaranteed by tests.

Both artifacts are committed to Git — the "delete the platform, keep readable
code" promise is preserved because the *projected* code is readable,
idiomatic, and self-contained.

## Consequences

- Golden tests become meaningful at two seams: prompt → spec (snapshot with
  semantic comparison) and spec → code (byte-identical snapshot).
- Security review concentrates on the compiler's templates once, instead of
  on every generated app.
- Expressiveness is bounded by the spec schema. Anything the schema can't
  express, the platform can't generate — schema evolution becomes the
  deliberate, versioned path for new capability, which is the correct
  pressure.
- The generator package and compiler package are cleanly separable
  (`packages/generator` and `packages/compiler`).
