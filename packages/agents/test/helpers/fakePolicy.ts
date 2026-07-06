/**
 * Fake, deny-by-default `PolicyEngine` (@openrupiv/policy) for unit tests.
 * Mirrors the real engine's fail-closed posture: with no `allow` predicate
 * supplied, every decision denies. Records every `decide()` call so tests
 * can assert the enforcement order (e.g. that policy is never consulted
 * when an earlier step already failed).
 */
import type { PolicyDecision, PolicyEngine, PolicyInput } from "@openrupiv/policy";

export interface FakePolicyOptions {
  /** Explicit allow predicate; omitted = deny everything (fail-closed default). */
  allow?: (input: PolicyInput) => boolean;
}

export class FakePolicy implements PolicyEngine {
  readonly calls: PolicyInput[] = [];

  constructor(private readonly opts: FakePolicyOptions = {}) {}

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    this.calls.push(input);
    const allow = this.opts.allow?.(input) ?? false;
    return {
      allow,
      reason: allow ? "allowed by fake policy" : "denied by default (fake policy)",
      policyId: "fake.policy",
    };
  }
}
