"""Fixture tool: attempts a real AF_INET connect to prove network egress is
blocked. If the inner seccomp filter is working, this process is killed by
SIGSYS before any output is produced -- the e2e script asserts THAT (an exit
via signal), not any printed output. Not a production tool."""
import socket

if __name__ == "__main__":
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(("8.8.8.8", 53))
    print('{"violation_not_blocked": true}')
