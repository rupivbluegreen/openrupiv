/**
 * Canonical valid specs. These are exported API, not just test data: the
 * compiler's determinism corpus, the generator's golden tests, and the docs
 * all build on them, so every downstream package exercises the same specs.
 */

import type { AppSpec } from "./types";

/**
 * The flagship Phase 1 demo: vendor onboarding with a 4-eyes approval
 * (two distinct approvers required on the `approve` transition).
 */
export const vendorOnboardingSpec: AppSpec = {
  specVersion: "0.1",
  app: {
    name: "Vendor Onboarding",
    slug: "vendor-onboarding",
    description:
      "Approval workflow for onboarding new vendors with 4-eyes review.",
    version: "0.1.0",
    roles: ["requester", "reviewer", "compliance"],
  },
  entities: [
    {
      name: "Vendor",
      description: "A company we may do business with.",
      fields: [
        { name: "name", type: "string", required: true, unique: true },
        { name: "contactEmail", type: "string", required: true },
        { name: "country", type: "string" },
        {
          name: "riskTier",
          type: "enum",
          values: ["low", "medium", "high"],
          default: "medium",
        },
      ],
    },
    {
      name: "VendorApplication",
      description: "A request to onboard a vendor.",
      fields: [
        { name: "vendor", type: "reference", entity: "Vendor", required: true },
        { name: "justification", type: "text", required: true },
        { name: "annualSpend", type: "number" },
        {
          name: "status",
          type: "enum",
          required: true,
          values: ["draft", "submitted", "in_review", "approved", "rejected"],
          default: "draft",
        },
      ],
    },
  ],
  pages: [
    { name: "vendors", type: "list", entity: "Vendor", title: "Vendors" },
    { name: "vendor-form", type: "form", entity: "Vendor", title: "New vendor" },
    {
      name: "applications",
      type: "list",
      entity: "VendorApplication",
      title: "Applications",
      fields: ["vendor", "status", "annualSpend"],
    },
    {
      name: "application-detail",
      type: "detail",
      entity: "VendorApplication",
      title: "Application",
    },
    {
      name: "application-form",
      type: "form",
      entity: "VendorApplication",
      title: "New application",
      fields: ["vendor", "justification", "annualSpend"],
    },
  ],
  workflows: [
    {
      name: "vendor-approval",
      entity: "VendorApplication",
      stateField: "status",
      initial: "draft",
      transitions: [
        {
          name: "submit",
          from: "draft",
          to: "submitted",
          guard: { roles: ["requester"] },
        },
        {
          name: "start-review",
          from: "submitted",
          to: "in_review",
          guard: { roles: ["reviewer"] },
        },
        {
          name: "approve",
          from: "in_review",
          to: "approved",
          guard: { roles: ["reviewer", "compliance"] },
          approval: { count: 2, roles: ["reviewer", "compliance"] },
        },
        {
          name: "reject",
          from: "in_review",
          to: "rejected",
          guard: { roles: ["reviewer", "compliance"] },
        },
      ],
    },
  ],
};

/**
 * Phase 2 demo: `vendorOnboardingSpec` extended with one v0.2 agent task
 * that proposes the `approve` transition (specs/phase-2-contracts.md §4).
 * Kept as a SEPARATE fixture — not a mutation of `vendorOnboardingSpec`
 * itself — so Phase 1 packages that assert against the original fixture
 * (compiler golden snapshots, the generator's few-shot prompt example, the
 * CLI's fixture-replay tests, the golden corpus's exact-match
 * "vendor-onboarding" entry) are completely unaffected by the v0.2 rollout.
 */
export const vendorOnboardingWithAgentSpec: AppSpec = {
  ...vendorOnboardingSpec,
  specVersion: "0.2",
  agents: [
    {
      name: "vendor-risk-review",
      description:
        "Reads a submitted vendor application and proposes approval when risk looks acceptable.",
      tools: ["read-vendor-application"],
      proposes: [{ workflow: "vendor-approval", transition: "approve" }],
    },
  ],
};

/** Smallest possible valid spec. */
export const minimalSpec: AppSpec = {
  specVersion: "0.1",
  app: { name: "Notes", slug: "notes", version: "0.1.0" },
  entities: [
    {
      name: "Note",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "body", type: "text" },
      ],
    },
  ],
};

/**
 * Exercises manyToMany relations and field-predicate guards
 * (no approval rules).
 */
export const projectTrackerSpec: AppSpec = {
  specVersion: "0.1",
  app: {
    name: "Project Tracker",
    slug: "project-tracker",
    version: "0.1.0",
    roles: ["member", "lead"],
  },
  entities: [
    {
      name: "Project",
      fields: [
        { name: "name", type: "string", required: true, unique: true },
        { name: "budget", type: "number" },
        { name: "dueDate", type: "date" },
        {
          name: "phase",
          type: "enum",
          required: true,
          values: ["planned", "active", "done"],
          default: "planned",
        },
      ],
      relations: [{ name: "tags", kind: "manyToMany", to: "Tag" }],
    },
    {
      name: "Tag",
      fields: [{ name: "label", type: "string", required: true, unique: true }],
    },
  ],
  pages: [
    { name: "projects", type: "list", entity: "Project" },
    { name: "project-form", type: "form", entity: "Project" },
    { name: "tags", type: "list", entity: "Tag" },
  ],
  workflows: [
    {
      name: "project-lifecycle",
      entity: "Project",
      stateField: "phase",
      initial: "planned",
      transitions: [
        {
          name: "kick-off",
          from: "planned",
          to: "active",
          guard: {
            roles: ["lead"],
            require: [{ field: "budget", op: "gt", value: 0 }],
          },
        },
        {
          name: "complete",
          from: "active",
          to: "done",
          guard: { require: [{ field: "dueDate", op: "set" }] },
        },
      ],
    },
  ],
};

/** All canonical fixtures, keyed by app slug. */
export const allFixtures: readonly AppSpec[] = [
  vendorOnboardingSpec,
  minimalSpec,
  projectTrackerSpec,
];
