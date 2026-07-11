/**
 * Boot canary (ADR-0007, "Boot canary — fail-closed, merge- and
 * healthcheck-blocking"). Runs a self-test jail through the exact same
 * jail-construction path production calls use (the actual assertion jail
 * script lives at `packages/sandbox/tools/canary/main.py`, exercised by
 * Task 10's Docker-based end-to-end test; this module only INTERPRETS its
 * report) and asserts, in order: no network interface, toolchain paths
 * read-only / host paths absent, rlimits actually applied, an AF_INET
 * socket() call is killed by SIGSYS, `no_new_privs` is set, a nested
 * user-namespace creation attempt via `clone`/`unshare` is killed, and a
 * nested user-namespace creation attempt via `clone3` returns `ENOSYS`.
 *
 * If ANY assertion fails, or the canary jail cannot even be run and report
 * back, this returns `{ ok: false, ... }` — `server.ts`'s `/healthz` route
 * reports unhealthy and `/v1/execute` refuses every request when this is
 * false. There is no fallback execution path; a sandbox that cannot prove
 * its own isolation stops accepting tool calls entirely.
 */

export interface CanaryAssertion {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CanaryResult {
  ok: boolean;
  assertions: CanaryAssertion[];
  at: string;
}

const EXPECTED_ASSERTION_NAMES = [
  "no_network_interface",
  "toolchain_ro",
  "host_path_absent",
  "rlimits_applied",
  "af_inet_socket_killed_by_sigsys",
  "no_new_privs",
  // The inner seccomp filter (packages/sandbox/seccomp/build-tool-seccomp.c,
  // fixed in Task 3) treats nested-userns creation asymmetrically and
  // deliberately: clone(CLONE_NEWUSER)/unshare(CLONE_NEWUSER) are
  // SECCOMP_RET_KILL_PROCESS (seccomp can inspect their flags argument
  // directly), while clone3 unconditionally returns ENOSYS via
  // SECCOMP_RET_ERRNO rather than being killed, because clone3 takes an
  // unfiltered `struct clone_args` pointer that seccomp cannot dereference
  // to flag-inspect (ADR-0007's clone3-ENOSYS requirement) — and ENOSYS
  // (not KILL) on clone3 is load-bearing: glibc probes clone3 first and
  // falls back to the (CLONE_NEWUSER-masked-killed) clone path only on
  // ENOSYS, so legitimate multi-threaded/multi-process Python keeps
  // working while a direct malicious clone3(CLONE_NEWUSER) still cannot
  // create the namespace. These are therefore two distinct assertions, not
  // one: a canary that lumped clone3 in with "killed" would be asserting
  // behavior the seccomp filter deliberately does not implement.
  "nested_userns_killed",
  "clone3_returns_enosys",
] as const;

export interface RunAssertionJailResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export async function runBootCanary(deps: {
  runAssertionJail: (script: string) => Promise<RunAssertionJailResult>;
}): Promise<CanaryResult> {
  const at = new Date().toISOString();
  const jailResult = await deps.runAssertionJail("canary");

  if (jailResult.exitCode !== 0) {
    return {
      ok: false,
      at,
      assertions: [
        {
          name: "canary_jail_execution",
          ok: false,
          detail: `canary jail did not exit cleanly: exit code ${jailResult.exitCode}, signal ${jailResult.signal ?? "none"}`,
        },
      ],
    };
  }

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(jailResult.stdout) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      at,
      assertions: [
        { name: "canary_jail_execution", ok: false, detail: "canary jail stdout was not valid JSON" },
      ],
    };
  }

  const assertions: CanaryAssertion[] = EXPECTED_ASSERTION_NAMES.map((name) => {
    const value = report[name];
    const ok = value === true;
    // Conditional spread (not `detail: undefined`): this repo's
    // tsconfig.base.json sets `exactOptionalPropertyTypes: true`, under
    // which explicitly assigning `undefined` to an optional field is a
    // type error distinct from omitting the key — same convention as
    // packages/audit/src/chain.ts's `subject` field.
    return { name, ok, ...(ok ? {} : { detail: `expected true, got ${JSON.stringify(value)}` }) };
  });

  return { ok: assertions.every((a) => a.ok), assertions, at };
}
