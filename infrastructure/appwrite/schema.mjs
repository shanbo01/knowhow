const varchar = (key, size = 128, options = {}) => ({
  key,
  type: "varchar",
  status: "available",
  error: "",
  required: false,
  array: false,
  size,
  default: null,
  ...options,
});

// Keep persisted email values on the portable varchar path used by the local
// CLI workflow. Application input remains email-normalized and the
// 254-character bound keeps compound email indexes within the varchar budget.
const email = (key) => varchar(key, 254);

const integer = (key, options = {}) => ({
  key,
  type: "integer",
  status: "available",
  error: "",
  required: false,
  array: false,
  min: 0,
  max: 2_147_483_647,
  default: null,
  ...options,
});

const datetime = (key) => ({
  key,
  type: "datetime",
  status: "available",
  error: "",
  required: false,
  array: false,
  default: null,
});

const text = (key, options = {}) => ({
  key,
  type: "text",
  status: "available",
  error: "",
  required: true,
  array: false,
  default: null,
  ...options,
});

const commonColumns = [
  varchar("organization_id", 36),
  varchar("workspace_id", 36),
  varchar("user_id", 36),
  varchar("subject_id", 128),
  varchar("slug", 128),
  email("email"),
  varchar("status", 40),
  varchar("kind", 40),
  varchar("idempotency_key", 128),
  varchar("request_id", 64),
  integer("sequence"),
  integer("version", { min: 1, default: 1 }),
  datetime("occurred_at"),
  datetime("expires_at"),
  datetime("scheduled_at"),
  datetime("deleted_at"),
  varchar("created_by", 36),
  varchar("updated_by", 36),
  text("payload_json"),
];

const index = (key, columns, type = "key") => ({ key, type, columns });

const definitions = [
  [
    "organizations",
    [index("by_status", ["status"]), index("by_slug", ["slug"], "unique")],
  ],
  [
    "organization_branding",
    [index("by_organization", ["organization_id"], "unique")],
  ],
  [
    "organization_memberships",
    [
      index("by_org_user", ["organization_id", "user_id"], "unique"),
      index("by_user_status", ["user_id", "status"]),
      index("by_org_status", ["organization_id", "status"]),
      index("by_org_user_status", ["organization_id", "user_id", "status"]),
      index("by_org_email_status", ["organization_id", "email", "status"]),
    ],
  ],
  [
    "workspaces",
    [
      index("by_organization", ["organization_id"]),
      index("by_org_status", ["organization_id", "status"]),
      index("by_slug", ["slug"], "unique"),
    ],
  ],
  ["workspace_settings", [index("by_workspace", ["workspace_id"], "unique")]],
  [
    "workspace_members",
    [
      index("by_workspace_user", ["workspace_id", "user_id"], "unique"),
      index("by_user_status", ["user_id", "status"]),
      index("by_workspace_email", ["workspace_id", "email"]),
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_workspace_user_status", ["workspace_id", "user_id", "status"]),
      index("by_email", ["email"]),
    ],
  ],
  [
    "workspace_groups",
    [
      index("by_workspace_kind", ["workspace_id", "kind"]),
      index("by_workspace_slug", ["workspace_id", "slug"], "unique"),
    ],
  ],
  [
    "group_memberships",
    [
      index("by_group_user", ["subject_id", "user_id"], "unique"),
      index("by_workspace_user", ["workspace_id", "user_id"]),
    ],
  ],
  [
    "guides",
    [
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_workspace_slug", ["workspace_id", "slug"], "unique"),
    ],
  ],
  [
    "guide_revisions",
    [
      index("by_guide_version", ["subject_id", "version"], "unique"),
      index("by_workspace_status", ["workspace_id", "status"]),
    ],
  ],
  [
    "guide_steps",
    [
      index("by_revision_sequence", ["subject_id", "sequence"], "unique"),
      index("by_workspace", ["workspace_id"]),
    ],
  ],
  [
    "guide_audiences",
    [
      index("by_revision_subject", ["subject_id", "kind", "user_id"]),
      index("by_workspace_kind", ["workspace_id", "kind"]),
      index("by_workspace_kind_user", ["workspace_id", "kind", "user_id"]),
    ],
  ],
  [
    "review_assignments",
    [
      index("by_revision_user", ["subject_id", "user_id"], "unique"),
      index("by_user_status", ["user_id", "status"]),
      index("by_workspace", ["workspace_id"]),
    ],
  ],
  [
    "captures",
    [
      index("by_workspace_user_status", ["workspace_id", "user_id", "status"]),
      index("by_idempotency", ["workspace_id", "idempotency_key"], "unique"),
      index("by_status_expiry", ["status", "expires_at"]),
    ],
  ],
  [
    "completions",
    [
      index("by_revision_user", ["subject_id", "user_id"], "unique"),
      index("by_workspace_time", ["workspace_id", "occurred_at"]),
    ],
  ],
  [
    "private_media",
    [
      index("by_workspace_revision", ["workspace_id", "subject_id"]),
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_workspace_revision_status", [
        "workspace_id",
        "subject_id",
        "status",
      ]),
    ],
  ],
  [
    "invitations",
    [
      index("by_token_hash", ["subject_id"], "unique"),
      index("by_workspace_status_expiry", [
        "workspace_id",
        "status",
        "expires_at",
      ]),
      index("by_email_status", ["email", "status"]),
      index("by_status_expiry", ["status", "expires_at"]),
    ],
  ],
  [
    "initial_admin_appointments",
    [
      index("by_token_hash", ["subject_id"], "unique"),
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_email_status", ["email", "status"]),
      index("by_status_expiry", ["status", "expires_at"]),
      index("by_org_status", ["organization_id", "status"]),
      index("by_org_email_status", ["organization_id", "email", "status"]),
    ],
  ],
  [
    "beta_access_grants",
    [
      index("by_token_hash", ["subject_id"], "unique"),
      index("by_status_expiry", ["status", "expires_at"]),
      index("by_email_status", ["email", "status"]),
      index("by_creator_time", ["created_by", "occurred_at"]),
    ],
  ],
  [
    "beta_access_events",
    [
      index("by_grant_status", ["subject_id", "status"]),
      index("by_grant_time", ["subject_id", "occurred_at"]),
      index("by_user_status", ["user_id", "status"]),
      index("by_email_kind", ["email", "kind"]),
      index("by_status_expiry", ["status", "expires_at"]),
    ],
  ],
  [
    "extension_devices",
    [
      index("by_workspace_user", ["workspace_id", "user_id"]),
      index("by_workspace_user_status", ["workspace_id", "user_id", "status"]),
      index("by_workspace_user_status_kind", [
        "workspace_id",
        "user_id",
        "status",
        "kind",
      ]),
      index("by_subject", ["subject_id"], "unique"),
      index("by_subject_status", ["subject_id", "status"]),
      index("by_status_expiry", ["status", "expires_at"]),
    ],
  ],
  [
    "platform_roles",
    [
      index("by_user_kind", ["user_id", "kind"], "unique"),
      index("by_user_status", ["user_id", "status"]),
      index("by_kind_status", ["kind", "status"]),
    ],
  ],
  [
    "support_cases",
    [
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_requester_status", ["user_id", "status"]),
      index("by_workspace_user_status", ["workspace_id", "user_id", "status"]),
    ],
  ],
  [
    "support_grants",
    [
      index("by_workspace_user_status", ["workspace_id", "user_id", "status"]),
      index("by_user_status", ["user_id", "status"]),
      index("by_expiry", ["status", "expires_at"]),
    ],
  ],
  [
    "audit_segments",
    [
      index("by_workspace_sequence", ["workspace_id", "sequence"], "unique"),
      index("by_workspace_kind_time", ["workspace_id", "kind", "occurred_at"]),
      index("by_org_time", ["organization_id", "occurred_at"]),
    ],
  ],
  [
    "catalog_items",
    [
      index("by_kind_status", ["kind", "status"]),
      index("by_slug", ["slug"], "unique"),
    ],
  ],
  [
    "subscriptions",
    [
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_org_status", ["organization_id", "status"]),
    ],
  ],
  [
    "entitlements",
    [
      index("by_workspace_kind", ["workspace_id", "kind"], "unique"),
      index("by_workspace_kind_status", ["workspace_id", "kind", "status"]),
      index("by_org_kind", ["organization_id", "kind"]),
    ],
  ],
  [
    "usage_events",
    [
      index("by_workspace_time", ["workspace_id", "occurred_at"]),
      index("by_workspace_kind", ["workspace_id", "kind"]),
      index("by_time", ["occurred_at"]),
      index("by_request", ["request_id"], "unique"),
      index("by_kind", ["kind"]),
    ],
  ],
  [
    "usage_rollups",
    [
      index(
        "by_workspace_kind_time",
        ["workspace_id", "kind", "occurred_at"],
        "unique",
      ),
    ],
  ],
  [
    "manual_invoices",
    [
      index("by_org_status", ["organization_id", "status"]),
      index("by_workspace_status", ["workspace_id", "status"]),
    ],
  ],
  [
    "leads",
    [
      index("by_email_status", ["email", "status"]),
      index("by_kind_time", ["kind", "occurred_at"]),
      index("by_status", ["status"]),
    ],
  ],
  [
    "support_tickets",
    [
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_user_status", ["user_id", "status"]),
      index("by_status", ["status"]),
    ],
  ],
  [
    "support_messages",
    [
      index("by_ticket_sequence", ["subject_id", "sequence"], "unique"),
      index("by_workspace_sequence", ["workspace_id", "sequence"]),
    ],
  ],
  [
    "notification_deliveries",
    [
      index("by_status_schedule", ["status", "scheduled_at"]),
      index("by_workspace", ["workspace_id"]),
      index("by_idempotency", ["idempotency_key"], "unique"),
    ],
  ],
  [
    "lifecycle_cases",
    [
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_kind_schedule", ["kind", "scheduled_at"]),
      index("by_status", ["status"]),
    ],
  ],
  [
    "export_jobs",
    [
      index("by_workspace_status", ["workspace_id", "status"]),
      index("by_idempotency", ["workspace_id", "idempotency_key"], "unique"),
      index("by_status_schedule", ["status", "scheduled_at"]),
      index("by_expiry", ["status", "expires_at"]),
    ],
  ],
  [
    "idempotency_keys",
    [
      index("by_workspace_key", ["workspace_id", "idempotency_key"], "unique"),
      index("by_expiry", ["expires_at"]),
    ],
  ],
  [
    "provisioning_runs",
    [
      index("by_org_status", ["organization_id", "status"]),
      index("by_user_status", ["user_id", "status"]),
      index("by_workspace", ["workspace_id"]),
      index("by_request", ["request_id"], "unique"),
    ],
  ],
  [
    "onboarding_progress",
    [index("by_workspace_user", ["workspace_id", "user_id"], "unique")],
  ],
  ["user_preferences", [index("by_user", ["user_id"], "unique")]],
];

export const databases = [
  {
    $id: "knowhow_core",
    name: "KnowHow Core",
    enabled: true,
  },
];

export const tables = definitions.map(([id, indexes]) => ({
  $id: id,
  $permissions: [],
  databaseId: "knowhow_core",
  name: id
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" "),
  enabled: true,
  rowSecurity: false,
  columns: commonColumns,
  indexes,
}));

export const expectedTableIds = definitions.map(([id]) => id);
