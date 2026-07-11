"""Fixture tool: echoes input.json back with a marker. Used by server.test.ts
and the e2e script's happy-path assertion, not a production tool."""
import json
import os

if __name__ == "__main__":
    payload = {}
    if os.path.exists("input.json"):
        with open("input.json") as f:
            payload = json.load(f)
    print(json.dumps({"echoed": True, "received": payload}))
