"""Fixture tool: attempts to write outside /workspace, proving filesystem
confinement. Unlike network_probe, this is NOT expected to be killed (RO/
absent paths raise a normal Python exception, not a seccomp kill) -- it
self-reports the exception type. Not a production tool."""
import json

if __name__ == "__main__":
    try:
        with open("/etc/openrupiv-escape-test", "w") as f:
            f.write("escaped")
        result = {"escaped": True}
    except (OSError, PermissionError) as exc:
        result = {"escaped": False, "error": type(exc).__name__, "errno": exc.errno}
    print(json.dumps(result))
