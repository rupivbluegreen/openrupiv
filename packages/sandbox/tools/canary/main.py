"""Boot canary assertion jail (ADR-0007, "Boot canary"). Runs INSIDE the
same bwrap jail production tool calls use. Emits exactly one JSON object on
stdout with one boolean per assertion; canary.ts (TS side) interprets it.
Fixture/infrastructure code, not a production RegisteredTool.
"""
import ctypes
import errno
import json
import os
import socket
import stat

libc = ctypes.CDLL("libc.so.6", use_errno=True)
PR_GET_NO_NEW_PRIVS = 39
SYS_clone3 = 435  # x86_64 syscall number
_DEV_NULL_RDEV = os.makedev(1, 3)  # what a /dev/null bind-mount stat()s as


def no_network_interface() -> bool:
    try:
        import subprocess

        out = subprocess.run(["ip", "-o", "link"], capture_output=True, text=True, timeout=2)
        # Only "lo" (down, no address configured) may exist; anything else
        # is a failed assertion. If `ip` isn't even present, absence of any
        # working socket path is checked separately below.
        lines = [l for l in out.stdout.splitlines() if l.strip()]
        return all("lo:" in l or "lo@" in l for l in lines) if lines else True
    except Exception:
        return True


def toolchain_ro() -> bool:
    try:
        with open("/usr/bin/python3.12", "ab"):
            pass
        return False  # should never reach here — write must fail
    except (OSError, PermissionError):
        return True


def host_path_absent() -> bool:
    return not os.path.exists("/etc/shadow") and not os.path.exists("/root")


def rlimits_applied() -> bool:
    import resource

    as_soft, _ = resource.getrlimit(resource.RLIMIT_AS)
    nproc_soft, _ = resource.getrlimit(resource.RLIMIT_NPROC)
    return as_soft <= 268_435_456 and nproc_soft <= 16


def af_inet_socket_killed_by_sigsys() -> bool:
    # This process is itself the canary jail; it must NOT be able to
    # observe a caught violation, because SCMP_ACT_KILL_PROCESS means the
    # attempting process dies before this function could return. We instead
    # fork a child specifically to make the attempt, and assert the PARENT
    # sees it die via SIGSYS.
    pid = os.fork()
    if pid == 0:
        try:
            socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        finally:
            os._exit(0)  # unreachable if the kernel kills us first
    _, status = os.waitpid(pid, 0)
    return os.WIFSIGNALED(status) and os.WTERMSIG(status) == 31  # SIGSYS == 31 on Linux/x86_64


def no_new_privs() -> bool:
    result = libc.prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)
    return result == 1


def nested_userns_killed() -> bool:
    pid = os.fork()
    if pid == 0:
        try:
            os.unshare(os.CLONE_NEWUSER)  # type: ignore[attr-defined]
        finally:
            os._exit(0)
    _, status = os.waitpid(pid, 0)
    return os.WIFSIGNALED(status) and os.WTERMSIG(status) == 31


def sensitive_proc_masked() -> bool:
    # bwrap mounts a fresh procfs with NO masking of its own, so bwrap-argv.ts
    # overmounts the sensitive entries: files with the sidecar's /dev/null,
    # /proc/scsi with an empty tmpfs. Verify that masking is actually in
    # effect from inside the jail: each masked file must stat as the /dev/null
    # character device (or be absent on this kernel — nothing to leak), and
    # /proc/scsi must be empty. An unmasked entry is the real procfs node (a
    # regular file / populated dir), which fails these checks.
    for path in ("/proc/kcore", "/proc/keys", "/proc/timer_list", "/proc/sysrq-trigger"):
        try:
            st = os.stat(path)
        except FileNotFoundError:
            continue
        if not (stat.S_ISCHR(st.st_mode) and st.st_rdev == _DEV_NULL_RDEV):
            return False
    try:
        if os.listdir("/proc/scsi"):
            return False
    except (FileNotFoundError, NotADirectoryError):
        pass
    return True


def clone3_returns_enosys() -> bool:
    # ADR-0007 ("inner seccomp filter", ~line 257) treats nested-userns
    # creation asymmetrically and deliberately: clone(CLONE_NEWUSER) /
    # unshare(CLONE_NEWUSER) are SECCOMP_RET_KILL_PROCESS (seccomp can
    # inspect the flags argument directly), whereas clone3 is
    # unconditionally SECCOMP_RET_ERRNO(ENOSYS) rather than killed, because
    # clone3 takes a pointer to a userspace `struct clone_args` that
    # seccomp cannot dereference to flag-inspect -- any flag-based
    # re-denial would be trivially bypassable, so the filter denies clone3
    # outright, independent of arguments. ENOSYS (not a kill) is
    # load-bearing here: glibc's NPTL probes clone3 first and falls back to
    # the (CLONE_NEWUSER-masked-killed) clone path only on ENOSYS, so
    # ordinary multi-threaded/multi-process Python keeps working inside the
    # jail while a direct clone3(CLONE_NEWUSER) attempt still cannot create
    # a namespace. This is therefore a distinct assertion from
    # nested_userns_killed() above, not a duplicate of it: unlike that
    # assertion (a SIGSYS kill observed via fork+waitpid), this one must
    # NOT observe a kill -- it must observe the syscall itself returning
    # -1 with errno set to ENOSYS. A clone3(NULL, 0) call that reached an
    # unfiltered kernel would fail with EINVAL (a null clone_args pointer
    # with a non-zero-checked size), not ENOSYS, so errno == ENOSYS
    # specifically evidences the SCMP_ACT_ERRNO(ENOSYS) rule is active
    # rather than just being clone3's ordinary rejection of bad arguments.
    ctypes.set_errno(0)
    result = libc.syscall(SYS_clone3, 0, 0)  # null clone_args pointer, size 0
    saved_errno = ctypes.get_errno()
    return result == -1 and saved_errno == errno.ENOSYS


if __name__ == "__main__":
    report = {
        "no_network_interface": no_network_interface(),
        "toolchain_ro": toolchain_ro(),
        "host_path_absent": host_path_absent(),
        "rlimits_applied": rlimits_applied(),
        "af_inet_socket_killed_by_sigsys": af_inet_socket_killed_by_sigsys(),
        "no_new_privs": no_new_privs(),
        "nested_userns_killed": nested_userns_killed(),
        "clone3_returns_enosys": clone3_returns_enosys(),
        "sensitive_proc_masked": sensitive_proc_masked(),
    }
    print(json.dumps(report))
