# openRupiv authorization policy (PDP entrypoint: openrupiv/authz/decision).
#
# Deny-by-default RBAC: a privileged action is allowed only when the subject
# holds at least one role the resource requires. The runtime calls this before
# workflow transitions, and (later) agent tool calls, MCP, and A2A. The
# decision object carries a reason so every allow AND deny is auditable.
#
# Compiled to WASM by scripts/build-policy.sh and committed as authz.wasm;
# the runtime evaluates it in-process (no sidecar) per ADR-0006.
package openrupiv.authz

import rego.v1

# The single entrypoint the engine evaluates. Always returns an object.
decision := {
	"allow": allow,
	"reason": reason,
}

default allow := false

# Allow when the subject holds any of the roles the resource requires.
allow if {
	count(required_roles) > 0
	some role in input.subject.roles
	role in required_roles
}

# An action that requires no roles is open to any authenticated subject.
allow if {
	count(required_roles) == 0
	input.subject.id != ""
}

required_roles := input.resource.allowed_roles

reason := "no roles required; authenticated subject permitted" if {
	allow
	count(required_roles) == 0
}

reason := sprintf("subject holds a required role for %v", [input.action]) if {
	allow
	count(required_roles) > 0
}

reason := sprintf(
	"subject roles %v do not intersect required roles %v for %v",
	[input.subject.roles, required_roles, input.action],
) if {
	not allow
}
