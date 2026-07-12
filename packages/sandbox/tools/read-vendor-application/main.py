"""read-vendor-application (ADR-0007 sandboxed tool for the `vendor-risk-review`
agent task). The jail has NO network and NO database access, so it cannot fetch
anything: the trusted runtime reads the VendorApplication record and passes its
fields in as `input.json`; this tool computes a DETERMINISTIC onboarding-risk
verdict from that data ALONE and prints it as JSON on stdout.

Deterministic (no clock, no randomness, no I/O beyond reading input.json), so
the same record always yields the same verdict — a real `RegisteredTool` a
governed agent task calls, not a fixture.

(The spec-declared tool name `read-vendor-application` is kept to avoid churning
the golden spec corpus; its real work is the risk assessment, since the runtime
now does the actual record read. Renaming to e.g. `assess-vendor-risk` is a
cosmetic follow-up.)

Output: {"risk": "low"|"high", "reasons": [<str>, ...]}
"""
import json
import os

# Annual spend above this needs elevated review (deterministic threshold).
SPEND_THRESHOLD = 100_000
MIN_JUSTIFICATION_CHARS = 20


def load_input() -> dict:
    if os.path.exists("input.json"):
        with open("input.json") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    return {}


def assess(record: dict) -> dict:
    reasons: list[str] = []

    spend = record.get("annualSpend")
    if isinstance(spend, (int, float)) and not isinstance(spend, bool) and spend > SPEND_THRESHOLD:
        reasons.append(f"annualSpend {spend} exceeds the {SPEND_THRESHOLD} review threshold")

    justification = record.get("justification")
    if not isinstance(justification, str) or len(justification.strip()) < MIN_JUSTIFICATION_CHARS:
        reasons.append(f"justification is missing or too brief (< {MIN_JUSTIFICATION_CHARS} chars)")

    # Any red flag escalates to human review; a clean record is recommendable.
    risk = "high" if reasons else "low"
    return {"risk": risk, "reasons": reasons or ["no blocking risk signals in the provided record"]}


if __name__ == "__main__":
    print(json.dumps(assess(load_input())))
