import type { PolicyEngine, PolicyInput, PolicyDecision } from "@openrupiv/policy";

export class FakePolicy implements PolicyEngine {
  async decide(_input: PolicyInput): Promise<PolicyDecision> {
    return { allow: true, reason: "fake policy allows everything", policyId: "fake" };
  }
}
