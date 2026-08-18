"use client";

import { useEffect, useState } from "react";
import { Filter, LoaderCircle, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryPlatform } from "../../../lib/knowhow-client";
import type {
  AccountTag,
  AdminAppointment,
  PlatformAccountRecord,
  PlatformAccountSummary,
  PlatformAuditSummary,
  PlatformDeletionCase,
  PlatformHome,
  PlatformLeadRecord,
  PlatformNotificationFailure,
  PlatformPage,
  PlatformPricingCatalog,
  PlatformTicketRecord,
  PlatformTicketSummary,
} from "../../../lib/knowhow-types";
import { platformHref, type PlatformSection } from "../../../lib/workspace-routes";
import { SelectMenu } from "../select-menu";
import {
  CommercialDialog,
  QueryPager,
  type CommercialMode,
} from "./platform-dialogs";
import {
  ACCOUNT_TAGS,
  commercialLabel,
  formatBytes,
  formatDate,
  healthLabel,
  initials,
  nextActionLabel,
  titleCase,
} from "./platform-format";

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className={`status-badge status-${status.toLowerCase()}`} variant="outline">
      {titleCase(status)}
    </Badge>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function useKeyedLoading(key: string) {
  const [activeKey, setActiveKey] = useState(key);
  const [loading, setLoading] = useState(true);
  if (activeKey !== key) {
    setActiveKey(key);
    setLoading(true);
  }
  return [loading, setLoading] as const;
}

export function PlatformHomeView({
  onNavigate,
}: {
  onNavigate: (href: string) => void;
}) {
  const [home, setHome] = useState<PlatformHome | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void queryPlatform<PlatformHome>({ resource: "home" })
      .then((data) => {
        if (!cancelled) {
          setHome(data);
          setError("");
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setError(
            nextError instanceof Error ? nextError.message : "Could not load home.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <p className="empty-copy">
        <LoaderCircle className="spin" /> Loading…
      </p>
    );
  }
  if (error) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }
  if (!home) return null;

  return (
    <div className="platform-home">
      <section className="section-heading">
        <div>
          <p className="eyebrow">KnowHow operator</p>
          <h1>Home</h1>
          <p className="lede">
            People worth talking to today. Counts are live operator queues, not vanity
            metrics.
          </p>
        </div>
      </section>
      <div className="platform-funnel" aria-label="Activation funnel">
        {home.funnel.map((step) => (
          <div key={step.id}>
            <strong>{step.count}</strong>
            <small>{step.label}</small>
          </div>
        ))}
      </div>
      {home.queues
        .filter((queue) => queue.items.length)
        .map((queue) => (
          <section className="card table-card" key={queue.id}>
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">{queue.items.length} in queue</p>
                <h2>{queue.title}</h2>
                <p>{queue.description}</p>
              </div>
            </div>
            <div className="member-table">
              {queue.items.map((item) => (
                <button
                  className="member-row"
                  type="button"
                  key={`${queue.id}:${item.workspaceId}:${item.name}`}
                  onClick={() => onNavigate(item.href)}
                >
                  <span className="avatar">{item.name.slice(0, 1)}</span>
                  <span className="member-main">
                    <strong>
                      {item.organizationName && item.organizationName !== item.name
                        ? `${item.organizationName} · ${item.name}`
                        : item.name}
                    </strong>
                    <small>
                      {commercialLabel(item.plan)}
                      {item.daysRemaining != null ? ` · ${item.daysRemaining}d left` : ""}
                      {item.intentScore ? ` · intent ${item.intentScore}` : ""}
                      {` · ${item.reason}`}
                    </small>
                  </span>
                  {item.nextAction !== "none" ? (
                    <Badge variant="outline">{nextActionLabel(item.nextAction)}</Badge>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      {!home.queues.some((queue) => queue.items.length) ? (
        <EmptyState
          title="Quiet morning"
          description="No trials, support breaches, or upgrade signals need you right now."
        />
      ) : null}
    </div>
  );
}

export function PlatformCustomersView({
  selectedId,
  canManage,
  canSupport,
  busy,
  onNavigate,
  onAssign,
  onRequestSupport,
  onStatus,
  onCommand,
}: {
  selectedId?: string;
  canManage: boolean;
  canSupport: boolean;
  busy: boolean;
  onNavigate: (href: string) => void;
  onAssign: (workspace: { id: string; name: string }) => void;
  onRequestSupport: (workspace: { id: string; name: string }) => void;
  onStatus: (workspaceId: string, status: "active" | "suspended" | "archived") => void;
  onCommand: (action: string, payload: unknown, success: string) => Promise<unknown>;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pageStack, setPageStack] = useState<Array<string | undefined>>([undefined]);
  const [items, setItems] = useState<PlatformPage<PlatformAccountSummary>>({
    items: [],
    nextCursor: null,
  });
  const [account, setAccount] = useState<PlatformAccountRecord | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [owner, setOwner] = useState("");
  const [tags, setTags] = useState<AccountTag[]>([]);
  const [commercial, setCommercial] = useState<CommercialMode | null>(null);
  const [reload, setReload] = useState(0);
  const requestKey = `${selectedId ?? ""}:${debounced}:${status}:${cursor ?? ""}:${reload}`;
  const [loading, setLoading] = useKeyedLoading(requestKey);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (selectedId) {
          const data = await queryPlatform<{ account: PlatformAccountRecord }>({
            resource: "customer",
            workspaceId: selectedId,
          });
          if (!cancelled) {
            setAccount(data.account);
            setNotes(data.account.organization?.internalNotes ?? "");
            setOwner(data.account.organization?.ownerLabel ?? "");
            setTags(data.account.organization?.accountTags ?? data.account.tags ?? []);
            setError("");
          }
        } else {
          const data = await queryPlatform<PlatformPage<PlatformAccountSummary>>({
            resource: "customers",
            q: debounced,
            status,
            cursor,
            limit: "20",
          });
          if (!cancelled) {
            setItems(data);
            setAccount(null);
            setError("");
          }
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error ? nextError.message : "Could not load customers.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, debounced, status, cursor, reload, setLoading]);

  if (selectedId) {
    if (loading && !account) {
      return (
        <p className="empty-copy">
          <LoaderCircle className="spin" /> Loading…
        </p>
      );
    }
    if (error) {
      return (
        <p className="form-error" role="alert">
          {error}
        </p>
      );
    }
    if (!account) {
      return (
        <EmptyState
          title="Customer not found"
          description="This workspace is no longer on the operator directory."
        />
      );
    }
    const usage = account.usage;
    return (
      <div className="platform-customer">
        <section className="section-heading">
          <div>
            <p className="eyebrow">Customer</p>
            <h1>{account.organizationName || account.name}</h1>
            <p>
              {account.organization?.primaryContactEmail ||
                account.administrators[0]?.email ||
                "No admin email"}
              {" · "}
              {commercialLabel(account.subscription?.plan)}
              {account.subscription?.expiresAt
                ? ` · expires ${formatDate(account.subscription.expiresAt)}`
                : ""}
              {` · signed up ${formatDate(account.createdAt)}`}
            </p>
          </div>
          <div className="platform-customer-chips">
            <StatusBadge status={account.status} />
            <Badge variant="outline">{healthLabel(account.health)}</Badge>
            {(account.tags ?? []).map((tag) => (
              <Badge variant="outline" key={tag}>
                {titleCase(tag)}
              </Badge>
            ))}
          </div>
        </section>
        {account.nextAction && account.nextAction !== "none" ? (
          <p className="platform-next-action">
            <Sparkles /> {nextActionLabel(account.nextAction)} — {account.nextActionReason}
          </p>
        ) : null}
        <section className="platform-stat-grid">
          <div>
            <small>Members</small>
            <strong>
              {account.memberCount}
              {account.seatLimit ? ` / ${account.seatLimit}` : ""}
            </strong>
          </div>
          <div>
            <small>Storage</small>
            <strong>
              {formatBytes(usage?.storageBytes ?? 0)}
              {usage?.storageLimit ? ` / ${formatBytes(usage.storageLimit)}` : ""}
            </strong>
          </div>
          <div>
            <small>Published</small>
            <strong>{account.publishedCount}</strong>
          </div>
          <div>
            <small>Captures</small>
            <strong>{usage?.captures ?? 0}</strong>
          </div>
          <div>
            <small>Exports</small>
            <strong>{usage?.exportRequests ?? 0}</strong>
          </div>
          <div>
            <small>Paywall hits</small>
            <strong>{usage?.paywallHits ?? 0}</strong>
          </div>
          <div>
            <small>Extension</small>
            <strong>
              {account.extension?.lastUsedAt
                ? formatDate(account.extension.lastUsedAt)
                : "Never"}
            </strong>
          </div>
        </section>
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Activation</h2>
            </div>
          </div>
          {(account.activationChecklist ?? []).map((step) => (
            <div className="member-row" key={step.id}>
              <span className="member-main">
                <strong>{step.label}</strong>
                <small>{step.completed ? formatDate(step.completedAt, true) : "Not yet"}</small>
              </span>
              <StatusBadge status={step.completed ? "complete" : "pending"} />
            </div>
          ))}
        </section>
        {(account.domainSiblings ?? []).length ? (
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <h2>Same-domain workspaces</h2>
                <p>
                  {(account.domainSiblings ?? []).length} other workspace
                  {(account.domainSiblings ?? []).length === 1 ? "" : "s"} on the
                  same company domain. Suggest clustering — do not auto-merge.
                </p>
              </div>
            </div>
            {(account.domainSiblings ?? []).map((sibling) => (
              <button
                className="member-row"
                type="button"
                key={sibling.workspaceId}
                onClick={() => onNavigate(platformHref("customers", sibling.workspaceId))}
              >
                <span className="member-main">
                  <strong>{sibling.name}</strong>
                  <small>@{sibling.domain}</small>
                </span>
              </button>
            ))}
          </section>
        ) : null}
        {canManage || canSupport ? (
          <div className="platform-actions">
            {canManage ? (
              <>
                <Button type="button" disabled={busy} onClick={() => setCommercial("trial")}>
                  Grant Pro trial
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setCommercial("extend")}>
                  Extend
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setCommercial("convert")}>
                  Change plan
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setCommercial("overrides")}>
                  Override limits
                </Button>
                {account.status === "active" ? (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => onStatus(account.id, "suspended")}>
                    Suspend
                  </Button>
                ) : (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => onStatus(account.id, "active")}>
                    Restore
                  </Button>
                )}
                <Button type="button" variant="outline" disabled={busy} onClick={() => onAssign({ id: account.id, name: account.name })}>
                  Assign admin
                </Button>
              </>
            ) : null}
            {canSupport ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onRequestSupport({ id: account.id, name: account.name })}
              >
                Request support access
              </Button>
            ) : null}
          </div>
        ) : null}
        {account.organization && canManage ? (
          <section className="card table-card">
            <div className="section-heading compact">
              <div>
                <h2>Internal notes</h2>
              </div>
            </div>
            <form
              className="modal-form platform-panel-form"
              onSubmit={async (event) => {
                event.preventDefault();
                await onCommand(
                  "updateOrganizationRecord",
                  {
                    organizationId: account.organization!.id,
                    internalNotes: notes,
                    ownerLabel: owner,
                    accountTags: tags,
                  },
                  "Customer notes saved",
                );
                setReload((value) => value + 1);
              }}
            >
            <label className="field">
              <span>Owner label</span>
              <input value={owner} onChange={(event) => setOwner(event.target.value)} />
            </label>
            <label className="field">
              <span>Internal notes</span>
              <textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
            <fieldset className="field">
              <legend>VIP / partner tags</legend>
              <div className="platform-tag-grid">
                {ACCOUNT_TAGS.map((tag) => (
                  <label className="choice-row" key={tag}>
                    <input
                      type="checkbox"
                      checked={tags.includes(tag)}
                      onChange={(event) =>
                        setTags((current) =>
                          event.target.checked
                            ? [...current, tag]
                            : current.filter((item) => item !== tag),
                        )
                      }
                    />
                    <span>{titleCase(tag)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <footer className="modal-footer">
              <Button type="submit" disabled={busy}>
                Save notes
              </Button>
            </footer>
            </form>
          </section>
        ) : null}
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Timeline</h2>
            </div>
          </div>
          {(account.timeline ?? []).length ? (
            (account.timeline ?? []).map((event, index) => (
              <div className="member-row" key={`${event.at}:${event.kind}:${index}`}>
                <span className="member-main">
                  <strong>{event.label}</strong>
                  <small>{formatDate(event.at, true)}</small>
                </span>
              </div>
            ))
          ) : (
            <p className="empty-copy">No timeline events yet.</p>
          )}
        </section>
        {commercial ? (
          <CommercialDialog
            mode={commercial}
            account={{ id: account.id, name: account.name }}
            subscription={account.subscription}
            busy={busy}
            onClose={() => setCommercial(null)}
            onGrantTrial={(days, reason) =>
              onCommand(
                "grantProTrial",
                { targetWorkspaceId: account.id, days, reason },
                "Pro trial granted",
              ).then(() => setReload((value) => value + 1))
            }
            onExtend={(expiresAt, reason) =>
              onCommand(
                "extendSubscription",
                {
                  targetWorkspaceId: account.id,
                  expiresAt,
                  reason,
                  graceDays: 0,
                  retentionDays: 90,
                },
                "Subscription extended",
              ).then(() => setReload((value) => value + 1))
            }
            onConvert={(input) =>
              onCommand(
                "convertSubscription",
                {
                  targetWorkspaceId: account.id,
                  plan: input.plan,
                  manualReference: input.manualReference,
                  expiresAt: input.expiresAt,
                  complimentary: input.complimentary,
                  reason: input.reason,
                },
                "Plan updated",
              ).then(() => setReload((value) => value + 1))
            }
            onOverride={(input) => {
              const overrides = [
                input.maximumUsers
                  ? { kind: "maximumUsers", value: input.maximumUsers, expiresAt: input.expiresAt }
                  : null,
                input.maximumCreators
                  ? {
                      kind: "maximumCreators",
                      value: input.maximumCreators,
                      expiresAt: input.expiresAt,
                    }
                  : null,
                input.storageGb
                  ? {
                      kind: "storageBytes",
                      value: Math.round(input.storageGb * 1_000_000_000),
                      expiresAt: input.expiresAt,
                    }
                  : null,
              ].filter(Boolean);
              return onCommand(
                "updateEntitlementOverrides",
                { targetWorkspaceId: account.id, reason: input.reason, overrides },
                "Limits overridden",
              ).then(() => setReload((value) => value + 1));
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <section className="card table-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Directory</p>
          <h1>Customers</h1>
        </div>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(undefined);
              setPageStack([undefined]);
            }}
            placeholder="Search company, workspace, or slug"
          />
        </label>
        <SelectMenu
          className="filter-select"
          leading={<Filter />}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setCursor(undefined);
            setPageStack([undefined]);
          }}
          ariaLabel="Filter customers"
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "trial", label: "Pro trial" },
            { value: "free", label: "Free" },
            { value: "pro", label: "Pro" },
            { value: "enterprise", label: "Enterprise" },
            { value: "high_intent", label: "High intent" },
            { value: "win_back", label: "Win-back" },
            { value: "at_risk", label: "At risk" },
            { value: "suspended", label: "Suspended" },
          ]}
        />
      </div>
      {loading ? <p className="empty-copy">Loading…</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="member-table">
        {items.items.map((item) => (
          <button
            className="member-row"
            type="button"
            key={item.id}
            onClick={() => onNavigate(platformHref("customers", item.id))}
          >
            <span className="avatar">{item.name.slice(0, 1)}</span>
            <span className="member-main">
              <strong>
                {item.organizationName && item.organizationName !== item.name
                  ? `${item.organizationName} · ${item.name}`
                  : item.name}
              </strong>
              <small>
                {commercialLabel(item.subscription?.plan)} · {healthLabel(item.health)}
                {item.memberCount ? ` · ${item.memberCount} people` : ""}
                {item.lastActivityAt ? ` · active ${formatDate(item.lastActivityAt)}` : ""}
              </small>
            </span>
            <StatusBadge status={item.status} />
          </button>
        ))}
      </div>
      {!loading && !items.items.length ? (
        <EmptyState
          title="No customers yet"
          description="Self-serve and provisioned workspaces will appear here."
        />
      ) : null}
      <QueryPager
        nextCursor={items.nextCursor}
        stack={pageStack}
        onPrev={() => {
          const next = pageStack.slice(0, -1);
          setPageStack(next.length ? next : [undefined]);
          setCursor(next.at(-1));
        }}
        onNext={() => {
          if (!items.nextCursor) return;
          setPageStack((current) => [...current, items.nextCursor ?? undefined]);
          setCursor(items.nextCursor ?? undefined);
        }}
      />
    </section>
  );
}

export function PlatformLeadsView({
  selectedId,
  canManage,
  busy,
  onNavigate,
  onCommand,
  onProvision,
}: {
  selectedId?: string;
  canManage: boolean;
  busy: boolean;
  onNavigate: (href: string) => void;
  onCommand: (action: string, payload: unknown, success: string) => Promise<unknown>;
  onProvision: (runId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("new");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pageStack, setPageStack] = useState<Array<string | undefined>>([undefined]);
  const [leads, setLeads] = useState<PlatformPage<PlatformLeadRecord>>({
    items: [],
    nextCursor: null,
  });
  const [lead, setLead] = useState<PlatformLeadRecord | null>(null);
  const [leadNotes, setLeadNotes] = useState("");
  const [leadStatus, setLeadStatus] = useState("new");
  const requestKey = `${selectedId ?? ""}:${debounced}:${status}:${cursor ?? ""}`;
  const [loading, setLoading] = useKeyedLoading(requestKey);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (selectedId) {
        const data = await queryPlatform<{ lead: PlatformLeadRecord }>({
          resource: "lead",
          leadId: selectedId,
        });
        if (!cancelled) {
          setLead(data.lead);
          setLeadNotes(data.lead.notes);
          setLeadStatus(data.lead.status);
        }
      } else {
        const data = await queryPlatform<PlatformPage<PlatformLeadRecord>>({
          resource: "leads",
          q: debounced,
          status,
          cursor,
          limit: "20",
        });
        if (!cancelled) {
          setLeads(data);
          setLead(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, debounced, status, cursor, setLoading]);

  if (selectedId && lead) {
    return (
      <section className="card table-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{titleCase(lead.kind)}</p>
            <h1>{lead.organization || lead.contactName}</h1>
          </div>
          <StatusBadge status={lead.status} />
        </div>
        <p>
          {lead.contactName} · {lead.email} · {lead.role || "No role"} · {lead.teamSize ?? "—"}{" "}
          people
        </p>
        <p>{lead.workflow || "No workflow described"}</p>
        {canManage ? (
          <form
            className="modal-form"
            onSubmit={async (event) => {
              event.preventDefault();
              await onCommand(
                "updateLead",
                { leadId: lead.id, status: leadStatus, notes: leadNotes },
                "Lead updated",
              );
            }}
          >
            <div className="field">
              <span>Status</span>
              <SelectMenu
                value={leadStatus}
                onChange={setLeadStatus}
                ariaLabel="Lead status"
                options={[
                  { value: "new", label: "New" },
                  { value: "qualified", label: "Qualified" },
                  { value: "waiting", label: "Waiting" },
                  { value: "converted", label: "Converted" },
                  { value: "rejected", label: "Rejected" },
                  { value: "closed", label: "Closed" },
                ]}
              />
            </div>
            <label className="field">
              <span>Internal notes</span>
              <textarea
                rows={5}
                value={leadNotes}
                onChange={(event) => setLeadNotes(event.target.value)}
              />
            </label>
            <footer className="modal-footer">
              <Button
                variant="outline"
                type="button"
                disabled={busy || lead.status === "converted"}
                onClick={async () => {
                  const result = (await onCommand(
                    "convertLead",
                    { leadId: lead.id },
                    "Lead converted — continue in provisioning",
                  )) as { runId?: string };
                  if (result.runId) onProvision(result.runId);
                }}
              >
                Convert to organization
              </Button>
              <Button type="submit" disabled={busy}>
                Save lead
              </Button>
            </footer>
          </form>
        ) : null}
      </section>
    );
  }

  return (
    <section className="card table-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Inbound</p>
          <h1>Leads</h1>
        </div>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search leads"
          />
        </label>
        <SelectMenu
          className="filter-select"
          leading={<Filter />}
          value={status}
          onChange={setStatus}
          ariaLabel="Filter leads by status"
          options={[
            { value: "all", label: "All statuses" },
            { value: "new", label: "New" },
            { value: "qualified", label: "Qualified" },
            { value: "waiting", label: "Waiting" },
            { value: "converted", label: "Converted" },
            { value: "rejected", label: "Rejected" },
            { value: "closed", label: "Closed" },
          ]}
        />
      </div>
      {loading ? <p className="empty-copy">Loading…</p> : null}
      {leads.items.map((item) => (
        <button
          className="member-row"
          type="button"
          key={item.id}
          onClick={() => onNavigate(platformHref("leads", item.id))}
        >
          <span className="avatar">
            {(item.organization || item.contactName || "?").slice(0, 1)}
          </span>
          <span className="member-main">
            <strong>{item.organization || item.contactName || item.email}</strong>
            <small>
              {item.contactName} · {item.email}
            </small>
          </span>
          <StatusBadge status={item.status} />
        </button>
      ))}
      {!loading && !leads.items.length ? (
        <EmptyState
          title="No inbound requests"
          description="New contact and demo requests will appear here."
        />
      ) : null}
      <QueryPager
        nextCursor={leads.nextCursor}
        stack={pageStack}
        onPrev={() => {
          const next = pageStack.slice(0, -1);
          setPageStack(next.length ? next : [undefined]);
          setCursor(next.at(-1));
        }}
        onNext={() => {
          if (!leads.nextCursor) return;
          setPageStack((current) => [...current, leads.nextCursor ?? undefined]);
          setCursor(leads.nextCursor ?? undefined);
        }}
      />
    </section>
  );
}

export function PlatformSupportView({
  selectedId,
  canSupport,
  busy,
  onNavigate,
  onCommand,
}: {
  selectedId?: string;
  canSupport: boolean;
  busy: boolean;
  onNavigate: (href: string) => void;
  onCommand: (action: string, payload: unknown, success: string) => Promise<unknown>;
}) {
  const [tickets, setTickets] = useState<PlatformPage<PlatformTicketSummary>>({
    items: [],
    nextCursor: null,
  });
  const [ticket, setTicket] = useState<PlatformTicketRecord | null>(null);
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useKeyedLoading(selectedId ?? "tickets");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (selectedId) {
        const [list, detail] = await Promise.all([
          queryPlatform<PlatformPage<PlatformTicketSummary>>({
            resource: "tickets",
            status: "open",
            limit: "20",
          }),
          queryPlatform<{ ticket: PlatformTicketRecord }>({
            resource: "ticket",
            ticketId: selectedId,
          }),
        ]);
        if (!cancelled) {
          setTickets(list);
          setTicket(detail.ticket);
        }
      } else {
        const list = await queryPlatform<PlatformPage<PlatformTicketSummary>>({
          resource: "tickets",
          status: "open",
          limit: "20",
        });
        if (!cancelled) {
          setTickets(list);
          setTicket(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, setLoading]);

  return (
    <div className="platform-support">
      <section className="card table-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Inbox</p>
            <h1>Support</h1>
          </div>
        </div>
        {loading ? <p className="empty-copy">Loading…</p> : null}
        {tickets.items.map((item) => (
          <button
            className="member-row"
            type="button"
            key={item.id}
            onClick={() => onNavigate(platformHref("support", item.id))}
          >
            <span className="member-main">
              <strong>{item.subject}</strong>
              <small>
                {item.workspaceName} · {item.requesterName}
              </small>
            </span>
            <StatusBadge status={item.status} />
          </button>
        ))}
        {!loading && !tickets.items.length ? (
          <EmptyState title="Inbox is clear" description="Open tickets will appear here." />
        ) : null}
      </section>
      {ticket ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>{ticket.subject}</h2>
              <p>
                {ticket.workspaceName} · {ticket.requesterEmail}
              </p>
            </div>
            <StatusBadge status={ticket.status} />
          </div>
          {ticket.messages.map((message) => (
            <div className="member-row" key={message.id}>
              <span className="avatar">{initials(message.authorName)}</span>
              <span className="member-main">
                <strong>{message.authorName}</strong>
                <small>{formatDate(message.createdAt, true)}</small>
                <p>{message.body}</p>
              </span>
            </div>
          ))}
          {canSupport && ticket.status !== "closed" ? (
            <form
              className="modal-form"
              onSubmit={async (event) => {
                event.preventDefault();
                await onCommand(
                  "replySupportTicket",
                  { ticketId: ticket.id, message: reply },
                  "Reply sent",
                );
                setReply("");
              }}
            >
              <label className="field">
                <span>Reply</span>
                <textarea
                  required
                  rows={4}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                />
              </label>
              <footer className="modal-footer">
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void onCommand("closeSupportTicket", { ticketId: ticket.id }, "Ticket closed")
                  }
                >
                  Close ticket
                </Button>
                <Button type="submit" disabled={busy}>
                  Send reply
                </Button>
              </footer>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function PlatformToolsView({
  canManage,
  isOwner,
  busy,
  catalogs,
  selfServiceLimit,
  onCommand,
  onApproveDeletion,
  onRevokeAppointment,
  onOpenCatalog,
  onProvision,
}: {
  canManage: boolean;
  isOwner: boolean;
  busy: boolean;
  catalogs: PlatformPricingCatalog[];
  selfServiceLimit: number;
  onCommand: (action: string, payload: unknown, success: string) => Promise<unknown>;
  onApproveDeletion: (item: PlatformDeletionCase) => void;
  onRevokeAppointment: (appointment: AdminAppointment) => void;
  onOpenCatalog: (catalog: PlatformPricingCatalog | "create") => void;
  onProvision: () => void;
}) {
  const [activity, setActivity] = useState<{
    audits: PlatformPage<PlatformAuditSummary>;
    notificationFailures: PlatformNotificationFailure[];
    deletionCases: PlatformDeletionCase[];
    appointments: AdminAppointment[];
  } | null>(null);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const limit = limitDraft ?? String(selfServiceLimit);

  useEffect(() => {
    let cancelled = false;
    void queryPlatform<{
      audits: PlatformPage<PlatformAuditSummary>;
      notificationFailures: PlatformNotificationFailure[];
      deletionCases: PlatformDeletionCase[];
      appointments: AdminAppointment[];
    }>({ resource: "tools" }).then((data) => {
      if (!cancelled) setActivity(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="platform-tools">
      <section className="section-heading">
        <div>
          <p className="eyebrow">Operator tools</p>
          <h1>Tools</h1>
          <p className="lede">
            Provisioning, trial catalogs, deletion approvals, and the audit feed.
          </p>
        </div>
        {canManage ? (
          <Button
            className="platform-inline-provision"
            type="button"
            disabled={busy}
            onClick={onProvision}
          >
            Provision organization
          </Button>
        ) : null}
      </section>
      {activity?.notificationFailures.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Failed notifications</h2>
            </div>
          </div>
          {activity.notificationFailures.map((item) => (
            <div className="member-row" key={item.id}>
              <span className="member-main">
                <strong>{item.kind}</strong>
                <small>
                  {item.workspaceName} · {item.attempts} attempt
                  {item.attempts === 1 ? "" : "s"} · last failed{" "}
                  {formatDate(item.lastFailedAt, true)}
                </small>
              </span>
            </div>
          ))}
        </section>
      ) : null}
      {isOwner && activity?.deletionCases.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Deletion approvals</h2>
            </div>
          </div>
          {activity.deletionCases.map((item) => (
            <div className="member-row" key={item.id}>
              <span className="member-main">
                <strong>{item.workspaceName}</strong>
                <small>Eligible {formatDate(item.eligibleAt, true)}</small>
              </span>
              <Button type="button" variant="destructive" onClick={() => onApproveDeletion(item)}>
                Review deletion
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      {canManage ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Private pricing catalogs</h2>
              <p>These terms apply to future self-service trials, not live workspaces.</p>
            </div>
            <Button type="button" onClick={() => onOpenCatalog("create")}>
              New catalog
            </Button>
          </div>
          {catalogs.map((catalog) => (
            <button
              className="member-row"
              type="button"
              key={catalog.id}
              onClick={() => onOpenCatalog(catalog)}
            >
              <span className="member-main">
                <strong>{catalog.name}</strong>
                <small>
                  {catalog.slug} · {catalog.status} · {catalog.trial.days}-day trial
                </small>
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {canManage && activity?.appointments.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Pending administrator appointments</h2>
            </div>
          </div>
          {activity.appointments.map((item) => (
            <div className="member-row" key={item.id}>
              <span className="member-main">
                <strong>{item.email}</strong>
                <small>Expires {formatDate(item.expiresAt, true)}</small>
              </span>
              <Button type="button" variant="outline" onClick={() => onRevokeAppointment(item)}>
                Revoke
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      {canManage ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Self-service workspace cap</h2>
            </div>
          </div>
          <form
            className="modal-form platform-panel-form"
            onSubmit={async (event) => {
              event.preventDefault();
              await onCommand(
                "updatePlatformSettings",
                { selfServiceWorkspaceLimit: Number(limit) },
                "Self-service cap saved",
              );
            }}
          >
            <label className="field">
              <span>Workspaces a person can create</span>
              <input
                type="number"
                min={0}
                value={limit}
                onChange={(event) => setLimitDraft(event.target.value)}
              />
              <small>Self-service limit: {selfServiceLimit}</small>
            </label>
            <footer className="modal-footer">
              <Button type="submit" disabled={busy || limit === ""}>
                Save cap
              </Button>
            </footer>
          </form>
        </section>
      ) : null}
      {activity?.audits.items.length ? (
        <section className="card table-card">
          <div className="section-heading compact">
            <div>
              <h2>Recent changes</h2>
            </div>
          </div>
          {activity.audits.items.map((item) => (
            <div className="member-row" key={item.id}>
              <span className="member-main">
                <strong>{item.action}</strong>
                <small>
                  {item.workspaceName} · {formatDate(item.occurredAt, true)}
                </small>
              </span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function sectionTitle(section: PlatformSection, entityId?: string) {
  if (section === "customers" && entityId) return "Customer";
  if (section === "leads" && entityId) return "Lead";
  if (section === "support" && entityId) return "Ticket";
  if (section === "overview") return "Home";
  if (section === "customers") return "Customers";
  if (section === "leads") return "Leads";
  if (section === "support") return "Support";
  return "Tools";
}
