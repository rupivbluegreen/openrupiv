#define _GNU_SOURCE
/*
 * Inner seccomp filter for the ADR-0007 tool jail. Compiled to a raw BPF
 * program via libseccomp and committed as packages/sandbox/seccomp/tool.bpf
 * -- exactly the precedent ADR-0006 set for the committed authz.wasm
 * policy bundle. Rebuilt via scripts/build-seccomp.sh; CI
 * (scripts/check-seccomp-bpf.sh) rebuilds and diffs against the committed
 * artifact whenever the toolchain is available, so the committed filter can
 * never go silently stale relative to the rules a reviewer actually read.
 *
 * Default action: ALLOW (this is the INNER filter -- the syscalls it kills
 * are exactly the ones ADR-0007's "Consequences" section names as the
 * honest residual risk of unprivileged-userns isolation; everything else a
 * real CPython process needs is left alone by design, not enumerated).
 *
 * SCMP_ACT_KILL_PROCESS, never SCMP_ACT_ERRNO: a policy violation inside
 * the jail is a non-negotiable kill, not a retriable error the tool code
 * could catch and work around.
 */
#include <seccomp.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#include <sys/socket.h>
#include <linux/net.h>

static int deny(scmp_filter_ctx ctx, int syscall_nr) {
    return seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, syscall_nr, 0);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <output.bpf>\n", argv[0]);
        return 2;
    }

    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) {
        fprintf(stderr, "seccomp_init failed\n");
        return 1;
    }

    /* Syscalls most consistently behind real unprivileged-userns Linux
     * kernel privilege-escalation bugs. This inner filter is deliberately
     * SELF-SUFFICIENT: it does not rely on the outer container seccomp
     * profile to close any of this surface, so the jail holds even if that
     * container is ever run with a weakened/`unconfined` outer profile.
     * That is why the modern mount API (fsopen/fsconfig/fsmount/move_mount/
     * open_tree/fspick) is denied alongside the legacy mount()/umount2(),
     * setns() alongside the CLONE_NEW* creation denials below, and add_key/
     * request_key alongside keyctl() -- each is the same LPE class as a
     * syscall already denied, and omitting them would leave the inner
     * filter leaning on the outer profile to finish the job. */
    const int denied_syscalls[] = {
        SCMP_SYS(mount),
        SCMP_SYS(umount2),
        SCMP_SYS(fsopen),
        SCMP_SYS(fsconfig),
        SCMP_SYS(fsmount),
        SCMP_SYS(move_mount),
        SCMP_SYS(open_tree),
        SCMP_SYS(fspick),
        SCMP_SYS(setns),
        SCMP_SYS(ptrace),
        SCMP_SYS(bpf),
        SCMP_SYS(keyctl),
        SCMP_SYS(add_key),
        SCMP_SYS(request_key),
        SCMP_SYS(userfaultfd),
        SCMP_SYS(io_uring_setup),
        SCMP_SYS(io_uring_enter),
        SCMP_SYS(io_uring_register),
        SCMP_SYS(process_vm_readv),
        SCMP_SYS(process_vm_writev),
        SCMP_SYS(open_by_handle_at),
        SCMP_SYS(perf_event_open),
    };
    for (size_t i = 0; i < sizeof(denied_syscalls) / sizeof(denied_syscalls[0]); i++) {
        if (deny(ctx, denied_syscalls[i]) != 0) {
            fprintf(stderr, "failed to add deny rule for syscall %d\n", denied_syscalls[i]);
            return 1;
        }
    }

    /* Nested user-namespace creation. clone3 unconditionally returns
     * ENOSYS (not flag-inspected, and not KILL_PROCESS): clone3 takes a
     * pointer to a userspace struct clone_args that seccomp cannot
     * dereference, so any flag-based re-denial would be trivially
     * bypassable -- the only sound mitigation is denying clone3 outright,
     * independent of arguments. ENOSYS rather than KILL is load-bearing:
     * modern glibc calls clone3 first for thread/process creation
     * (pthread_create, posix_spawn, fork) and falls back to the clone
     * syscall below ONLY on ENOSYS, so legitimate multi-threaded/
     * multi-process Python continues to work via the (CLONE_NEWUSER-
     * masked-killed) clone path, while a direct malicious clone3(
     * CLONE_NEWUSER) still cannot create the namespace. */
    if (seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, SCMP_SYS(clone),
                          1, SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)) != 0) {
        fprintf(stderr, "failed to add clone/CLONE_NEWUSER deny rule\n");
        return 1;
    }
    /* unshare() takes its flags directly as a scalar arg0 (unlike
     * clone3), so seccomp CAN inspect it: mask-match CLONE_NEWUSER only,
     * leaving unshare() of other namespace types allowed. */
    if (seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, SCMP_SYS(unshare),
                          1, SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)) != 0) {
        fprintf(stderr, "failed to add unshare/CLONE_NEWUSER deny rule\n");
        return 1;
    }
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0) != 0) {
        fprintf(stderr, "failed to add clone3 ENOSYS rule\n");
        return 1;
    }

    /* socket(): AF_UNIX only. --unshare-net already removes any network
     * interface, so AF_UNIX (including abstract sockets, scoped per netns
     * by the kernel) is safe and needed by Python's stdlib. Every other
     * family is denied, EXPLICITLY including AF_NETLINK -- nf_tables/
     * netfilter CVEs reachable via AF_NETLINK sockets are the canonical
     * unprivileged-userns kernel-LPE route in the current CVE landscape. */
    if (seccomp_rule_add(ctx, SCMP_ACT_KILL_PROCESS, SCMP_SYS(socket),
                          1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)) != 0) {
        fprintf(stderr, "failed to add socket() family-restriction rule\n");
        return 1;
    }

    int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        perror("open");
        return 1;
    }
    int rc = seccomp_export_bpf(ctx, fd);
    close(fd);
    seccomp_release(ctx);
    if (rc != 0) {
        fprintf(stderr, "seccomp_export_bpf failed: %d\n", rc);
        return 1;
    }
    return 0;
}
