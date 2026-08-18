import { TABLES } from "./appwrite-resources";
import {
  decodePayload,
  rowData,
  type CatalogCharge,
  type CatalogEntitlementItem,
  type PricingCatalogRecord,
  type PricingCatalogStatus,
} from "./domain-records";
import { HttpError } from "./http-security";
import { resourceId } from "./ids";
import {
  inputBoolean,
  inputInteger,
  inputObject,
  inputText,
  slugify,
} from "./input";
import type { RecordStore } from "./record-store";

const DEFAULT_FEATURES: CatalogEntitlementItem[] = [
  {
    key: "browser_extension",
    label: "Browser capture extension",
    included: true,
    note: "Capture, redact, review, and pair managed devices.",
  },
  {
    key: "privacy_tools",
    label: "Smart Blur, redact, and annotate",
    included: true,
    note: "Local screenshot privacy tools before anything is uploaded.",
  },
  {
    key: "custom_subdomain",
    label: "Custom subdomain",
    included: true,
    note: "team.knowhow.app preview. DNS is provisioned separately.",
  },
  {
    key: "remove_branding",
    label: "Remove KnowHow branding",
    included: true,
    note: "Use workspace identity on the app and exports.",
  },
  {
    key: "governed_exports",
    label: "Governed exports",
    included: true,
    note: "Policy-controlled PDF, PowerPoint, and HTML exports.",
  },
];

const DEFAULT_SERVICES: CatalogEntitlementItem[] = [
  {
    key: "in_app_support",
    label: "In-app support",
    included: true,
    note: "In-app support with a one-business-day response target.",
  },
];

export const BUILT_IN_PRIVATE_BETA_TRIAL_CATALOG: Readonly<PricingCatalogRecord> =
  Object.freeze({
    schemaVersion: 1,
    catalogVersion: "trial-v1",
    name: "KnowHow Pro trial",
    description:
      "Deterministic no-card Pro trial defaults used when no effective platform catalog exists.",
    status: "active",
    currency: "USD",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    selfServiceTrial: true,
    trial: { days: 14, graceDays: 7, retentionDays: 90 },
    baseWorkspace: {
      amountMinor: null,
      unit: "workspace_month",
      includedActiveCreators: 25,
      includedActiveUsers: 100,
      includedStorageBytes: 5_000_000_000,
    },
    additionalUsage: {
      creator: { amountMinor: null, unit: "active_creator_month" },
      user: { amountMinor: null, unit: "active_user_month" },
      storage: { amountMinor: null, unit: "storage_gb_month" },
    },
    features: DEFAULT_FEATURES,
    services: DEFAULT_SERVICES,
    futureOptions: {
      ssoScim: {
        available: false,
        included: false,
        amountMinor: null,
        unit: "manual_contract",
      },
      supportSla: {
        available: false,
        included: false,
        level: "best_effort",
        responseTargetHours: null,
        amountMinor: null,
        unit: "manual_contract",
      },
      sovereignDeployment: {
        available: true,
        included: false,
        amountMinor: null,
        unit: "manual_contract",
      },
      dedicatedDeployment: {
        available: true,
        included: false,
        amountMinor: null,
        unit: "manual_contract",
      },
    },
    securityFundamentalsIncluded: true,
    paymentsEnabled: false,
    manualContractAllowed: true,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "knowhow_builtin",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "knowhow_builtin",
  } satisfies PricingCatalogRecord);

export type EffectiveTrialPlan = {
  catalogItemId: string;
  catalogVersion: string;
  trialDays: number;
  graceDays: number;
  retentionDays: number;
  entitlements: Record<string, string | number | boolean>;
};

function validIsoDate(value: unknown, label: string, nullable = false) {
  if (nullable && (value === null || value === undefined || value === ""))
    return null;
  const raw = inputText(value, label, { min: 10, max: 40 });
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, "CATALOG_DATE_INVALID", `${label} is invalid.`);
  }
  return new Date(parsed).toISOString();
}

function optionalMinorAmount(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return null;
  return inputInteger(value, label, 0, 1_000_000_000_000);
}

function catalogKey(value: unknown, label: string) {
  const key = inputText(value, label, { min: 2, max: 64 }).toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new HttpError(400, "CATALOG_KEY_INVALID", `${label} is invalid.`);
  }
  return key;
}

function entitlementItems(
  value: unknown,
  label: string,
  fallback: CatalogEntitlementItem[],
) {
  if (value === undefined) return structuredClone(fallback);
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "CATALOG_ITEMS_INVALID", `${label} is invalid.`);
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const item = inputObject(candidate, `${label} item`);
    const key = catalogKey(item.key, `${label} key`);
    if (seen.has(key)) {
      throw new HttpError(
        400,
        "CATALOG_ITEMS_DUPLICATE",
        `${label} contains a duplicate key.`,
      );
    }
    seen.add(key);
    return {
      key,
      label: inputText(item.label, `${label} label`, { min: 2, max: 100 }),
      included: inputBoolean(item.included, `${label} inclusion`),
      note: inputText(item.note ?? "", `${label} note`, {
        max: 300,
        optional: true,
      }),
    } satisfies CatalogEntitlementItem;
  });
}

function charge<TUnit extends CatalogCharge["unit"]>(
  raw: unknown,
  label: string,
  unit: TUnit,
  fallback: CatalogCharge,
): CatalogCharge & { unit: TUnit } {
  const value = raw === undefined ? {} : inputObject(raw, label);
  return {
    amountMinor: optionalMinorAmount(
      value.amountMinor === undefined
        ? fallback.amountMinor
        : value.amountMinor,
      `${label} amount`,
    ),
    unit,
  };
}

function optionCharge<TUnit extends CatalogCharge["unit"]>(
  raw: unknown,
  label: string,
  unit: TUnit,
  fallback: CatalogCharge & { available: boolean; included?: boolean },
) {
  const value = raw === undefined ? {} : inputObject(raw, label);
  return {
    ...charge(value, label, unit, fallback),
    available:
      value.available === undefined
        ? fallback.available
        : inputBoolean(value.available, `${label} availability`),
    included:
      value.included === undefined
        ? (fallback.included ?? false)
        : inputBoolean(value.included, `${label} inclusion`),
  };
}

export function normalizePricingCatalog(
  raw: Record<string, unknown>,
  actorUserId: string,
  options: { previous?: PricingCatalogRecord; now?: Date } = {},
): PricingCatalogRecord {
  const previous = options.previous ?? BUILT_IN_PRIVATE_BETA_TRIAL_CATALOG;
  const now = (options.now ?? new Date()).toISOString();
  const status = inputText(raw.status ?? previous.status, "Catalog status", {
    min: 5,
    max: 10,
  }) as PricingCatalogStatus;
  if (!["draft", "scheduled", "active"].includes(status)) {
    throw new HttpError(
      400,
      "CATALOG_STATUS_INVALID",
      "Create or update a catalog as draft, scheduled, or active.",
    );
  }
  const currency = inputText(raw.currency ?? previous.currency, "Currency", {
    min: 3,
    max: 3,
  }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new HttpError(
      400,
      "CATALOG_CURRENCY_INVALID",
      "Use an ISO currency code.",
    );
  }
  const effectiveFrom = validIsoDate(
    raw.effectiveFrom ?? previous.effectiveFrom,
    "Effective date",
  )!;
  const effectiveUntil = validIsoDate(
    raw.effectiveUntil === undefined
      ? previous.effectiveUntil
      : raw.effectiveUntil,
    "Effective end date",
    true,
  );
  if (
    effectiveUntil &&
    Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)
  ) {
    throw new HttpError(
      400,
      "CATALOG_EFFECTIVE_RANGE_INVALID",
      "The effective end must follow the effective start.",
    );
  }
  const trialInput =
    raw.trial === undefined
      ? {}
      : inputObject(raw.trial, "Trial configuration");
  const baseInput =
    raw.baseWorkspace === undefined
      ? {}
      : inputObject(raw.baseWorkspace, "Base workspace");
  const usageInput =
    raw.additionalUsage === undefined
      ? {}
      : inputObject(raw.additionalUsage, "Additional usage");
  const futureInput =
    raw.futureOptions === undefined
      ? {}
      : inputObject(raw.futureOptions, "Future options");
  const supportInput =
    futureInput.supportSla === undefined
      ? {}
      : inputObject(futureInput.supportSla, "Support SLA");
  const supportBase = previous.futureOptions.supportSla;
  const baseCharge = charge(
    baseInput,
    "Base workspace",
    "workspace_month",
    previous.baseWorkspace,
  );
  const revision = options.previous ? options.previous.revision + 1 : 1;
  return {
    schemaVersion: 1,
    catalogVersion: inputText(
      raw.catalogVersion ?? previous.catalogVersion,
      "Catalog version",
      { min: 1, max: 40 },
    ),
    name: inputText(raw.name ?? previous.name, "Catalog name", {
      min: 2,
      max: 120,
    }),
    description: inputText(
      raw.description ?? previous.description,
      "Catalog description",
      { max: 500, optional: true },
    ),
    status,
    currency,
    effectiveFrom,
    effectiveUntil,
    selfServiceTrial:
      raw.selfServiceTrial === undefined
        ? previous.selfServiceTrial
        : inputBoolean(raw.selfServiceTrial, "Self-service trial"),
    trial: {
      days: inputInteger(
        trialInput.days ?? previous.trial.days,
        "Trial days",
        1,
        90,
      ),
      graceDays: inputInteger(
        trialInput.graceDays ?? previous.trial.graceDays,
        "Grace days",
        0,
        30,
      ),
      retentionDays: inputInteger(
        trialInput.retentionDays ?? previous.trial.retentionDays,
        "Retention days",
        30,
        365,
      ),
    },
    baseWorkspace: {
      ...baseCharge,
      includedActiveCreators: inputInteger(
        baseInput.includedActiveCreators ??
          previous.baseWorkspace.includedActiveCreators,
        "Included active creators",
        1,
        100_000,
      ),
      includedActiveUsers: inputInteger(
        baseInput.includedActiveUsers ??
          previous.baseWorkspace.includedActiveUsers,
        "Included active users",
        1,
        1_000_000,
      ),
      includedStorageBytes: inputInteger(
        baseInput.includedStorageBytes ??
          previous.baseWorkspace.includedStorageBytes,
        "Included storage",
        1_000_000,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    additionalUsage: {
      creator: charge(
        usageInput.creator,
        "Additional creator",
        "active_creator_month",
        previous.additionalUsage.creator,
      ),
      user: charge(
        usageInput.user,
        "Additional user",
        "active_user_month",
        previous.additionalUsage.user,
      ),
      storage: charge(
        usageInput.storage,
        "Additional storage",
        "storage_gb_month",
        previous.additionalUsage.storage,
      ),
    },
    features: entitlementItems(raw.features, "Features", previous.features),
    services: entitlementItems(raw.services, "Services", previous.services),
    futureOptions: {
      ssoScim: optionCharge(
        futureInput.ssoScim,
        "SSO and SCIM",
        "manual_contract",
        previous.futureOptions.ssoScim,
      ),
      supportSla: {
        ...optionCharge(
          supportInput,
          "Support SLA",
          "manual_contract",
          supportBase,
        ),
        level: inputText(
          supportInput.level ?? supportBase.level,
          "Support SLA level",
          { min: 2, max: 80 },
        ),
        responseTargetHours:
          supportInput.responseTargetHours === null
            ? null
            : inputInteger(
                supportInput.responseTargetHours ??
                  supportBase.responseTargetHours ??
                  24,
                "Support response target",
                1,
                720,
              ),
      },
      sovereignDeployment: optionCharge(
        futureInput.sovereignDeployment,
        "Sovereign deployment",
        "manual_contract",
        previous.futureOptions.sovereignDeployment,
      ),
      dedicatedDeployment: optionCharge(
        futureInput.dedicatedDeployment,
        "Dedicated deployment",
        "manual_contract",
        previous.futureOptions.dedicatedDeployment,
      ),
    },
    securityFundamentalsIncluded: true,
    paymentsEnabled: false,
    manualContractAllowed: true,
    revision,
    createdAt: options.previous?.createdAt ?? now,
    createdBy: options.previous?.createdBy ?? actorUserId,
    updatedAt: now,
    updatedBy: actorUserId,
  };
}

export function catalogEntitlements(catalog: PricingCatalogRecord) {
  const included = (items: CatalogEntitlementItem[], key: string) =>
    items.some((item) => item.key === key && item.included);
  return {
    maximumUsers: catalog.baseWorkspace.includedActiveUsers,
    maximumCreators: catalog.baseWorkspace.includedActiveCreators,
    storageBytes: catalog.baseWorkspace.includedStorageBytes,
    extensionEnabled: included(catalog.features, "browser_extension"),
    supportEnabled: included(catalog.services, "in_app_support"),
    removeBranding: included(catalog.features, "remove_branding"),
    privacyToolsEnabled: included(catalog.features, "privacy_tools"),
    customSubdomainEnabled: included(catalog.features, "custom_subdomain"),
    publicSignup: false,
    payments: false,
    ssoScim: catalog.futureOptions.ssoScim.included,
  } satisfies Record<string, string | number | boolean>;
}

function isEffective(catalog: PricingCatalogRecord, at: Date) {
  if (!["active", "scheduled"].includes(catalog.status)) return false;
  const timestamp = at.getTime();
  return (
    Date.parse(catalog.effectiveFrom) <= timestamp &&
    (!catalog.effectiveUntil || timestamp < Date.parse(catalog.effectiveUntil))
  );
}

export async function resolveSelfServiceTrialPlan(
  store: RecordStore,
  at = new Date(),
): Promise<EffectiveTrialPlan> {
  const rows = await store.list(TABLES.catalogItems, {
    filters: [{ field: "kind", value: "pricing_catalog" }],
    limit: 5_001,
  });
  const configured = rows
    .flatMap((row) => {
      const catalog = decodePayload<PricingCatalogRecord | null>(row, null);
      return catalog?.selfServiceTrial && isEffective(catalog, at)
        ? [{ row, catalog }]
        : [];
    })
    .sort(
      (left, right) =>
        Date.parse(right.catalog.effectiveFrom) -
          Date.parse(left.catalog.effectiveFrom) ||
        right.catalog.revision - left.catalog.revision,
    )[0];
  const catalog = configured?.catalog ?? BUILT_IN_PRIVATE_BETA_TRIAL_CATALOG;
  return {
    catalogItemId: configured?.row.$id ?? "built_in_trial_default",
    catalogVersion: catalog.catalogVersion,
    trialDays: catalog.trial.days,
    graceDays: catalog.trial.graceDays,
    retentionDays: catalog.trial.retentionDays,
    entitlements: catalogEntitlements(catalog),
  };
}

export type PricingCatalogView = PricingCatalogRecord & {
  id: string;
  slug: string;
};

export class PricingCatalogService {
  constructor(private readonly store: RecordStore) {}

  async list(): Promise<PricingCatalogView[]> {
    return (
      await this.store.list(TABLES.catalogItems, {
        filters: [{ field: "kind", value: "pricing_catalog" }],
        order: "desc",
        limit: 5_001,
      })
    ).flatMap((row) => {
      const catalog = decodePayload<PricingCatalogRecord | null>(row, null);
      return catalog
        ? [{ ...catalog, id: row.$id, slug: String(row.slug ?? row.$id) }]
        : [];
    });
  }

  async create(
    actorUserId: string,
    raw: Record<string, unknown>,
    now = new Date(),
  ): Promise<PricingCatalogView> {
    const catalog = normalizePricingCatalog(raw, actorUserId, { now });
    const baseSlug = slugify(
      inputText(
        raw.slug ?? `${catalog.name}-${catalog.catalogVersion}`,
        "Catalog slug",
        {
          min: 2,
          max: 96,
        },
      ),
    );
    const duplicates = await this.store.list(TABLES.catalogItems, {
      filters: [{ field: "slug", value: baseSlug }],
      limit: 1,
    });
    if (duplicates.length) {
      throw new HttpError(
        409,
        "CATALOG_SLUG_EXISTS",
        "That catalog slug already exists.",
      );
    }
    const id = resourceId("catalog");
    await this.store.create(
      TABLES.catalogItems,
      id,
      rowData(
        {
          slug: baseSlug,
          kind: "pricing_catalog",
          status: catalog.status,
          version: catalog.revision,
          occurred_at: catalog.effectiveFrom,
          expires_at: catalog.effectiveUntil,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        catalog,
      ),
    );
    return { ...catalog, id, slug: baseSlug };
  }

  async update(
    actorUserId: string,
    catalogId: string,
    expectedRevision: number,
    raw: Record<string, unknown>,
    now = new Date(),
  ): Promise<PricingCatalogView> {
    const row = await this.store.get(TABLES.catalogItems, catalogId);
    if (!row || row.kind !== "pricing_catalog") {
      throw new HttpError(
        404,
        "CATALOG_NOT_FOUND",
        "Pricing catalog not found.",
      );
    }
    const current = decodePayload<PricingCatalogRecord | null>(row, null);
    if (!current) {
      throw new HttpError(
        409,
        "CATALOG_CORRUPT",
        "Pricing catalog is unavailable.",
      );
    }
    if (current.revision !== expectedRevision) {
      throw new HttpError(
        409,
        "CATALOG_REVISION_CONFLICT",
        "The catalog changed. Refresh before saving again.",
      );
    }
    if (current.status === "retired") {
      throw new HttpError(
        409,
        "CATALOG_RETIRED",
        "A retired catalog is immutable.",
      );
    }
    const catalog = normalizePricingCatalog(raw, actorUserId, {
      previous: current,
      now,
    });
    await this.store.update(
      TABLES.catalogItems,
      catalogId,
      rowData(
        {
          slug: String(row.slug),
          kind: "pricing_catalog",
          status: catalog.status,
          version: catalog.revision,
          occurred_at: catalog.effectiveFrom,
          expires_at: catalog.effectiveUntil,
          updated_by: actorUserId,
        },
        catalog,
      ),
    );
    return { ...catalog, id: catalogId, slug: String(row.slug) };
  }

  async retire(
    actorUserId: string,
    catalogId: string,
    expectedRevision: number,
    now = new Date(),
  ): Promise<PricingCatalogView> {
    const row = await this.store.get(TABLES.catalogItems, catalogId);
    const current = row
      ? decodePayload<PricingCatalogRecord | null>(row, null)
      : null;
    if (!row || row.kind !== "pricing_catalog" || !current) {
      throw new HttpError(
        404,
        "CATALOG_NOT_FOUND",
        "Pricing catalog not found.",
      );
    }
    if (current.revision !== expectedRevision) {
      throw new HttpError(
        409,
        "CATALOG_REVISION_CONFLICT",
        "The catalog changed. Refresh before retiring it.",
      );
    }
    if (current.status === "retired") {
      return { ...current, id: catalogId, slug: String(row.slug) };
    }
    const retiredAt = now.toISOString();
    const catalog: PricingCatalogRecord = {
      ...current,
      status: "retired",
      revision: current.revision + 1,
      updatedAt: retiredAt,
      updatedBy: actorUserId,
      retiredAt,
      retiredBy: actorUserId,
    };
    await this.store.update(
      TABLES.catalogItems,
      catalogId,
      rowData(
        {
          slug: String(row.slug),
          kind: "pricing_catalog",
          status: "retired",
          version: catalog.revision,
          occurred_at: catalog.effectiveFrom,
          expires_at: catalog.effectiveUntil,
          updated_by: actorUserId,
        },
        catalog,
      ),
    );
    return { ...catalog, id: catalogId, slug: String(row.slug) };
  }
}
