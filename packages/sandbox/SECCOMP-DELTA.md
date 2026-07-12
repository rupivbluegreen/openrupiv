# `docker-seccomp.json` — what it is and how to diff it

`packages/sandbox/docker-seccomp.json` is applied to the `sandbox` Compose
service via `security_opt: seccomp=packages/sandbox/docker-seccomp.json`
(ADR-0007, "Compose wiring"). Docker's `security_opt: seccomp=<file>`
**replaces** the daemon's default profile — it does not merge or layer onto
it — so this file must be a complete, functional seccomp profile, not a
delta/patch fragment. (An earlier version of this file shipped as a
delta-only stub with `defaultAction: SCMP_ACT_ERRNO` and no real allow
rules; applied as a `security_opt`, that killed the container on the first
syscall. See ADR-0007 Task 9 fix notes.)

## Base

moby/moby's default seccomp profile, pinned at tag **`v27.3.1`**:

```
curl -fsSL https://raw.githubusercontent.com/moby/moby/v27.3.1/profiles/seccomp/default.json
```

Fetched verbatim: `defaultAction: SCMP_ACT_ERRNO`, `defaultErrnoRet: 1`, the
same `archMap`, and all 31 syscall-group rules, unmodified.

## The one delta

A single rule is **prepended** to the front of the `syscalls` array:

```json
{
  "names": ["clone", "unshare", "mount", "umount2", "pivot_root"],
  "action": "SCMP_ACT_ALLOW",
  "args": [],
  "comment": "ADR-0007 outer delta: ... This is the ONLY change from moby's default profile v27.3.1 ..."
}
```

**Why these 5, unconditionally:** bubblewrap needs `unshare`/`clone` (with
namespace flags), `mount`, `umount2`, and `pivot_root` to build its jail.
moby's default profile already allows `clone`/`unshare`/`mount`/`umount2`
— but only when the calling process holds `CAP_SYS_ADMIN` (see the
`includes.caps: ["CAP_SYS_ADMIN"]` condition on that rule). `pivot_root`
isn't in the default profile's allowlist at all — it falls through to
`defaultAction` (ERRNO) unconditionally. This container adds **no**
capabilities (`CAP_SYS_ADMIN` is never granted — that's the entire point
of bubblewrap's unprivileged-user-namespace design over the rejected
`--privileged`/`CAP_SYS_ADMIN` alternative in ADR-0007), so without this
rule every one of these 5 calls falls through to `SCMP_ACT_ERRNO` and bwrap
cannot construct a jail at all.

**Why not `clone3`:** the default profile also has a `clone3` rule gated
the same way (`includes.caps: ["CAP_SYS_ADMIN"]`, falling back to an
explicit `SCMP_ACT_ERRNO` entry otherwise). ADR-0007 authorizes exactly 5
syscalls for the bwrap delta; `clone3` is deliberately **not** added here.
Do not add it without a superseding ADR decision.

**What is NOT changed:** no Linux capability is added anywhere in the
Dockerfile or Compose wiring, `defaultAction` stays `SCMP_ACT_ERRNO`, and
every other syscall rule in the moby default is untouched.

## Reviewing a future bump

To re-diff against a newer moby tag `<NEW_TAG>`:

```
curl -fsSL https://raw.githubusercontent.com/moby/moby/<NEW_TAG>/profiles/seccomp/default.json -o /tmp/moby-new.json
python3 -c "
import json
with open('packages/sandbox/docker-seccomp.json') as f:
    ours = json.load(f)
# drop the prepended delta rule (index 0) before diffing against upstream
ours['syscalls'] = ours['syscalls'][1:]
with open('/tmp/ours-stripped.json', 'w') as f:
    json.dump(ours, f, indent=2)
"
diff <(python3 -m json.tool /tmp/moby-new.json) <(python3 -m json.tool /tmp/ours-stripped.json)
```

A clean diff (other than intentional upstream changes you're accepting)
confirms the only local change is still the single 5-syscall delta rule.
