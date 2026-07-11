/**
 * The ONE place a `bwrap` argv is assembled (ADR-0007, "Per-call jail
 * construction"). Always an argv array handed to `execFile`/`spawn` --
 * never string-interpolated into a shell, so there is no injection surface
 * by construction. `entrypointPath` MUST already be resolved and
 * canonicalized by `resolveEntrypoint` (entrypoint.ts) before reaching this
 * function; this function does not re-validate it.
 *
 * `pythonRoot` and `toolRoot` are bound read-only at the SAME path inside
 * the jail as on the sidecar's own filesystem (simplifies entrypoint-path
 * translation: the path resolved outside the jail is the same path Python
 * sees inside it). `workspaceHostPath` is the only read-write bind, always
 * mounted at `/workspace` inside the jail regardless of its host path.
 */

export interface BwrapArgvOptions {
  /** Absolute host path of this run's workspace directory (the only RW bind). */
  workspaceHostPath: string;
  /** Absolute path of the Python 3.12 runtime root, RO-bound at the same path. */
  pythonRoot: string;
  /** Absolute path of the tool root (hash-pinned vendored code), RO-bound at the same path. */
  toolRoot: string;
  /** FD number, as seen by the child process, holding the compiled inner seccomp BPF program. */
  seccompFd: number;
  /** Resolved, canonicalized path (via resolveEntrypoint) of the tool's main.py. */
  entrypointPath: string;
}

export function buildBwrapArgv(opts: BwrapArgvOptions): string[] {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    "--ro-bind", opts.pythonRoot, opts.pythonRoot,
    "--ro-bind", opts.toolRoot, opts.toolRoot,
    "--bind", opts.workspaceHostPath, "/workspace",
    "--chdir", "/workspace",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--seccomp", String(opts.seccompFd),
    "--",
    `${opts.pythonRoot}/bin/python3`,
    opts.entrypointPath,
  ];
}
