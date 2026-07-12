import { describe, expect, it } from "vitest";
import { runBootCanary } from "../src/canary";

const HAPPY_STDOUT = JSON.stringify({
  no_network_interface: true,
  toolchain_ro: true,
  host_path_absent: true,
  rlimits_applied: true,
  af_inet_socket_killed_by_sigsys: true,
  no_new_privs: true,
  nested_userns_killed: true,
  clone3_returns_enosys: true,
  sensitive_proc_masked: true,
});

describe("runBootCanary", () => {
  it("reports ok:true when every assertion in the jail's JSON report is true", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: HAPPY_STDOUT, exitCode: 0, signal: null }),
    });
    expect(result.ok).toBe(true);
    expect(result.assertions.every((a) => a.ok)).toBe(true);
    expect(result.assertions.map((a) => a.name).sort()).toEqual(
      [
        "af_inet_socket_killed_by_sigsys",
        "clone3_returns_enosys",
        "host_path_absent",
        "nested_userns_killed",
        "no_network_interface",
        "no_new_privs",
        "rlimits_applied",
        "sensitive_proc_masked",
        "toolchain_ro",
      ].sort(),
    );
  });

  it("reports ok:false when any single assertion is false", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({
        stdout: JSON.stringify({ ...JSON.parse(HAPPY_STDOUT), no_network_interface: false }),
        exitCode: 0,
        signal: null,
      }),
    });
    expect(result.ok).toBe(false);
    const failed = result.assertions.find((a) => a.name === "no_network_interface");
    expect(failed?.ok).toBe(false);
  });

  it("reports ok:false (fail closed) if the canary jail itself crashes instead of reporting", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: "", exitCode: 1, signal: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.assertions).toEqual([
      { name: "canary_jail_execution", ok: false, detail: expect.stringContaining("exit code 1") },
    ]);
  });

  it("reports ok:false (fail closed) if the canary jail's stdout is not valid JSON", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: "not json", exitCode: 0, signal: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.assertions[0]?.name).toBe("canary_jail_execution");
  });

  it("reports ok:false (fail closed) if the canary jail's stdout is a bare JSON value rather than an object", async () => {
    const resultNull = await runBootCanary({
      runAssertionJail: async () => ({ stdout: "null", exitCode: 0, signal: null }),
    });
    expect(resultNull.ok).toBe(false);
    expect(resultNull.assertions[0]?.name).toBe("canary_jail_execution");

    const resultNumber = await runBootCanary({
      runAssertionJail: async () => ({ stdout: "42", exitCode: 0, signal: null }),
    });
    expect(resultNumber.ok).toBe(false);
    expect(resultNumber.assertions[0]?.name).toBe("canary_jail_execution");
  });

  it("stamps an ISO timestamp", async () => {
    const result = await runBootCanary({
      runAssertionJail: async () => ({ stdout: HAPPY_STDOUT, exitCode: 0, signal: null }),
    });
    expect(() => new Date(result.at).toISOString()).not.toThrow();
  });
});
