"""Fixture tool: sleeps far longer than wallClockMs, to prove the
supervisor's wall-clock timer actually SIGKILLs a stuck jail. Not a
production tool."""
import time

if __name__ == "__main__":
    time.sleep(300)
    print('{"should_never_print": true}')
