"use client";

import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Clock3,
  Command,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileKey,
  FileText,
  Filter,
  HardDrive,
  KeyRound,
  Laptop,
  Link2,
  ListChecks,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Network,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type View = "Overview" | "Runbooks" | "Assets" | "Secrets" | "Vendors";

type Step = {
  title: string;
  body: string;
  code?: string;
  link?: string;
  warning?: string;
};

type Runbook = {
  id: string;
  code: string;
  title: string;
  group: string;
  summary: string;
  duration: string;
  freshness: "Verified" | "Review due" | "Overdue";
  freshnessNote: string;
  reviewNote: string;
  updated: string;
  steps: Step[];
};

const clients = [
  { id: "northstar", short: "NTD", name: "Northstar Dental", status: "Healthy" },
  { id: "bluebird", short: "BBL", name: "Bluebird Logistics", status: "Watch" },
  { id: "aster", short: "ASH", name: "Aster House", status: "Healthy" },
];

const runbooks: Runbook[] = [
  {
    id: "vpn-mfa",
    code: "SOP-014",
    title: "Reset GlobalProtect MFA for a user",
    group: "Remote access",
    summary:
      "Use when a Northstar user changes phones, loses Authenticator access, or gets stuck in a SAML sign-in loop.",
    duration: "4 min",
    freshness: "Verified",
    freshnessNote: "Verified Jul 18 by Maya Chen",
    reviewNote: "Review due Oct 18",
    updated: "12d ago",
    steps: [
      {
        title: "Rule out a service outage",
        body: "Check Microsoft 365 service health and Palo Alto status. If more than one user is affected, open the linked outage response instead.",
        link: "Remote access outage response",
      },
      {
        title: "Confirm the requester",
        body: "Match the ticket caller against the employee record or obtain approval from Leila Hassan, Office Manager.",
      },
      {
        title: "Revoke existing sessions",
        body: "Open Entra ID → Users → Revoke sessions. Allow up to five minutes for the change to propagate.",
        code: "Revoke-MgUserSignInSession -UserId user@northstar-dental.example",
      },
      {
        title: "Require MFA re-registration",
        body: "In Authentication methods, select Require re-register multifactor authentication. Do not remove existing methods manually.",
        warning: "Removing methods can break emergency access and should be escalated.",
      },
      {
        title: "Reconnect and verify",
        body: "Reconnect to vpn.northstar-dental.example, confirm an address in 10.24.40.0/24, then update the ticket.",
      },
    ],
  },
  {
    id: "offboard-user",
    code: "SOP-021",
    title: "Offboard a Microsoft 365 user safely",
    group: "Identity & access",
    summary:
      "Disable access, preserve business data, transfer ownership, and document the offboarding outcome.",
    duration: "12 min",
    freshness: "Verified",
    freshnessNote: "Verified Jul 22 by Jules Stone",
    reviewNote: "Review due Nov 22",
    updated: "8d ago",
    steps: [
      {
        title: "Validate the approved request",
        body: "Confirm the effective date, manager, data owner, and legal hold requirements in the service ticket.",
      },
      {
        title: "Block sign-in and revoke sessions",
        body: "Block sign-in in Entra ID, revoke all active sessions, and reset the account password.",
      },
      {
        title: "Preserve mailbox and OneDrive",
        body: "Convert the mailbox to shared, grant the approved delegate, and start the OneDrive retention workflow.",
      },
      {
        title: "Remove assigned licenses",
        body: "Remove paid licenses only after the mailbox conversion and retention checks have completed.",
      },
      {
        title: "Close the record",
        body: "Update the asset owner, password custody, and offboarding ticket with the completion note.",
      },
    ],
  },
  {
    id: "sharepoint-restore",
    code: "SOP-032",
    title: "Restore a deleted SharePoint file",
    group: "Microsoft 365",
    summary:
      "Recover a deleted or overwritten file while preserving the original site permissions and version history.",
    duration: "7 min",
    freshness: "Review due",
    freshnessNote: "Review due Aug 02",
    reviewNote: "Owner: Microsoft 365 queue",
    updated: "44d ago",
    steps: [
      {
        title: "Confirm the site and file path",
        body: "Ask for the original filename, site, folder, owner, and approximate deletion time.",
      },
      {
        title: "Check version history",
        body: "If the file still exists, restore the required version instead of using the recycle bin.",
      },
      {
        title: "Check both recycle bins",
        body: "Search the site recycle bin, then the second-stage recycle bin if needed.",
      },
      {
        title: "Validate access",
        body: "Open the restored file with the requester and confirm the existing permissions remain correct.",
      },
    ],
  },
  {
    id: "firewall-rotate",
    code: "SOP-008",
    title: "Rotate the firewall admin credential",
    group: "Network",
    summary:
      "Rotate the named firewall administrator credential and record the change without interrupting monitoring.",
    duration: "9 min",
    freshness: "Overdue",
    freshnessNote: "Review overdue 6d",
    reviewNote: "Was due Jul 23",
    updated: "98d ago",
    steps: [
      {
        title: "Open a maintenance record",
        body: "Create the change record and notify the on-call technician before modifying the credential.",
      },
      {
        title: "Validate secondary access",
        body: "Confirm the break-glass administrator works before changing the named account.",
      },
      {
        title: "Rotate and test",
        body: "Generate a new credential in the vault, update the firewall, then test a fresh login.",
      },
      {
        title: "Update dependent services",
        body: "Check monitoring, configuration backup, and automation jobs for stored credentials.",
      },
    ],
  },
];

const assets = [
  {
    id: "AST-2041",
    name: "NTD-FW-01",
    type: "Palo Alto PA-440",
    address: "10.24.0.1",
    owner: "Infrastructure",
    status: "Healthy",
    seen: "8m ago",
    serial: "PA44-NTD-8821",
    location: "Main office · Comms room",
  },
  {
    id: "AST-2038",
    name: "NTD-DC-01",
    type: "Windows Server 2022",
    address: "10.24.0.10",
    owner: "Core services",
    status: "Healthy",
    seen: "2m ago",
    serial: "VM-NTD-DC01",
    location: "Azure · Qatar Central",
  },
  {
    id: "AST-2184",
    name: "NTD-LT-042",
    type: "Dell Latitude 7450",
    address: "10.24.40.62",
    owner: "Leila Hassan",
    status: "Watch",
    seen: "31m ago",
    serial: "DL7450-KP41",
    location: "Main office · Reception",
  },
  {
    id: "AST-2012",
    name: "NTD-NAS-01",
    type: "Synology RS1221+",
    address: "10.24.0.18",
    owner: "Backup",
    status: "At risk",
    seen: "3h ago",
    serial: "SYN-NTD-1217",
    location: "Main office · Comms room",
  },
];

const secrets = [
  {
    id: "SEC-0048",
    name: "M365 Global Admin",
    linked: "NTD-M365 · Entra ID",
    access: "Restricted",
    rotated: "31d ago",
    value: "DEMO-M365-NOT-A-SECRET",
  },
  {
    id: "SEC-0031",
    name: "Firewall break-glass",
    linked: "NTD-FW-01",
    access: "Tier 2",
    rotated: "11d ago",
    value: "DEMO-FIREWALL-NOT-A-SECRET",
  },
  {
    id: "SEC-0064",
    name: "Synology local admin",
    linked: "NTD-NAS-01",
    access: "Tier 1",
    rotated: "87d ago",
    value: "DEMO-NAS-NOT-A-SECRET",
  },
];

const vendors = [
  {
    id: "VND-0011",
    name: "Palo Alto Networks",
    service: "Firewall support",
    renewal: "Nov 30, 2026",
    notice: "30 days",
    owner: "Maya Chen",
    status: "Current",
  },
  {
    id: "VND-0004",
    name: "Microsoft",
    service: "Microsoft 365 Business Premium",
    renewal: "Jan 14, 2027",
    notice: "Monthly",
    owner: "Finance queue",
    status: "Current",
  },
  {
    id: "VND-0023",
    name: "Gulf Data Systems",
    service: "Fiber internet · 500 Mbps",
    renewal: "Aug 18, 2026",
    notice: "45 days",
    owner: "Jules Stone",
    status: "Action needed",
  },
  {
    id: "VND-0017",
    name: "Veeam",
    service: "Backup & replication",
    renewal: "Mar 01, 2027",
    notice: "60 days",
    owner: "Maya Chen",
    status: "Current",
  },
];

const searchRecords = [
  {
    type: "Runbook",
    title: "Reset GlobalProtect MFA for a user",
    path: "Northstar Dental / Remote access",
    excerpt: "…re-register MFA before reconnecting GlobalProtect VPN…",
    meta: "Verified 12d ago",
    target: "vpn-mfa",
  },
  {
    type: "Asset",
    title: "NTD-FW-01",
    path: "Northstar Dental / Network",
    excerpt: "Palo Alto PA-440 · 10.24.0.1 · Main office",
    meta: "Seen 8m ago",
    target: "AST-2041",
  },
  {
    type: "Secret",
    title: "M365 Global Admin",
    path: "Northstar Dental / Microsoft 365",
    excerpt: "Restricted credential · plaintext excluded from search",
    meta: "Rotated 31d ago",
    target: "SEC-0048",
  },
  {
    type: "Runbook",
    title: "Remote access outage response",
    path: "Northstar Dental / Remote access",
    excerpt: "Triage SAML, ISP, and firewall failures affecting VPN access…",
    meta: "Verified 21d ago",
    target: "vpn-mfa",
  },
  {
    type: "Vendor",
    title: "Palo Alto Networks",
    path: "Northstar Dental / Vendors",
    excerpt: "Firewall support · contract renews Nov 30",
    meta: "Current",
    target: "VND-0011",
  },
  {
    type: "Runbook",
    title: "Offboard a Microsoft 365 user safely",
    path: "Northstar Dental / Identity & access",
    excerpt: "Disable access, preserve data, and transfer ownership…",
    meta: "Verified 8d ago",
    target: "offboard-user",
  },
];

const navItems: Array<{ label: View; icon: LucideIcon; count?: string }> = [
  { label: "Overview", icon: Activity },
  { label: "Runbooks", icon: BookOpen, count: "38" },
  { label: "Assets", icon: HardDrive, count: "67" },
  { label: "Secrets", icon: KeyRound, count: "14" },
  { label: "Vendors", icon: Archive, count: "8" },
];

function FreshnessBadge({ value }: { value: Runbook["freshness"] }) {
  return (
    <span className={`freshness freshness-${value.toLowerCase().replace(" ", "-")}`}>
      {value === "Verified" ? <ShieldCheck size={13} /> : <Clock3 size={13} />}
      {value}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={`status-dot status-${status.toLowerCase().replace(" ", "-")}`}>
      <span aria-hidden="true" />
      {status}
    </span>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        <p className="coordinate">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="section-actions">{action}</div> : null}
    </header>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("Runbooks");
  const [activeClient, setActiveClient] = useState(clients[0]);
  const [selectedRunbookId, setSelectedRunbookId] = useState(runbooks[0].id);
  const [completed, setCompleted] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("Everything");
  const [searchIndex, setSearchIndex] = useState(0);
  const [runbookFilter, setRunbookFilter] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [secretQuery, setSecretQuery] = useState("");
  const [vendorQuery, setVendorQuery] = useState("");
  const [toast, setToast] = useState("");
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [secretCountdown, setSecretCountdown] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState<(typeof assets)[number] | null>(null);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [runCompletedAt, setRunCompletedAt] = useState<Record<string, string>>({});
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const searchDialogRef = useRef<HTMLDivElement>(null);
  const assetDrawerRef = useRef<HTMLElement>(null);
  const contextDrawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const selectedRunbook =
    runbooks.find((runbook) => runbook.id === selectedRunbookId) ?? runbooks[0];
  const completedForRunbook = completed[selectedRunbook.id] ?? [];
  const isRunning = running[selectedRunbook.id] ?? false;
  const isFinished =
    isRunning && completedForRunbook.length === selectedRunbook.steps.length;
  const completionTime = runCompletedAt[selectedRunbook.id]
    ? `${new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Qatar",
      }).format(new Date(runCompletedAt[selectedRunbook.id]))} AST`
    : "Just now";

  const filteredRunbooks = useMemo(() => {
    const query = runbookFilter.trim().toLowerCase();
    if (!query) return runbooks;
    return runbooks.filter((runbook) =>
      `${runbook.code} ${runbook.title} ${runbook.group} ${runbook.freshness}`
        .toLowerCase()
        .includes(query),
    );
  }, [runbookFilter]);

  const filteredAssets = useMemo(() => {
    const query = assetQuery.trim().toLowerCase();
    if (!query) return assets;
    return assets.filter((asset) =>
      `${asset.id} ${asset.name} ${asset.type} ${asset.address} ${asset.owner} ${asset.serial}`
        .toLowerCase()
        .includes(query),
    );
  }, [assetQuery]);

  const filteredSecrets = useMemo(() => {
    const query = secretQuery.trim().toLowerCase();
    if (!query) return secrets;
    return secrets.filter((secret) =>
      `${secret.id} ${secret.name} ${secret.linked} ${secret.access}`
        .toLowerCase()
        .includes(query),
    );
  }, [secretQuery]);

  const filteredVendors = useMemo(() => {
    const query = vendorQuery.trim().toLowerCase();
    if (!query) return vendors;
    return vendors.filter((vendor) =>
      `${vendor.id} ${vendor.name} ${vendor.service} ${vendor.owner} ${vendor.status}`
        .toLowerCase()
        .includes(query),
    );
  }, [vendorQuery]);

  const filteredSearch = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return searchRecords.filter((record) => {
      const matchesType = searchType === "Everything" || record.type === searchType;
      const matchesQuery =
        !query ||
        `${record.type} ${record.title} ${record.path} ${record.excerpt} ${record.meta}`
          .toLowerCase()
          .includes(query);
      return matchesType && matchesQuery;
    });
  }, [searchQuery, searchType]);

  const rememberFocus = () => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const restoreFocus = () => {
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  };

  const openSearch = () => {
    rememberFocus();
    setMobileNavOpen(false);
    setSearchOpen(true);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchType("Everything");
    restoreFocus();
  };

  const openAsset = (asset: (typeof assets)[number]) => {
    rememberFocus();
    setMobileNavOpen(false);
    setSelectedAsset(asset);
  };

  const closeAsset = () => {
    setSelectedAsset(null);
    restoreFocus();
  };

  const openContextDrawer = () => {
    rememberFocus();
    setMobileNavOpen(false);
    setContextDrawerOpen(true);
  };

  const closeContextDrawer = () => {
    setContextDrawerOpen(false);
    restoreFocus();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setMobileNavOpen(false);
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        const hadLayer = searchOpen || Boolean(selectedAsset) || contextDrawerOpen;
        setSearchOpen(false);
        setSearchQuery("");
        setSearchType("Everything");
        setSelectedAsset(null);
        setContextDrawerOpen(false);
        setNewMenuOpen(false);
        if (hadLayer) {
          window.setTimeout(() => returnFocusRef.current?.focus(), 0);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, selectedAsset, contextDrawerOpen]);

  useEffect(() => {
    const dialog = searchOpen
      ? searchDialogRef.current
      : selectedAsset
        ? assetDrawerRef.current
        : contextDrawerOpen
          ? contextDrawerRef.current
          : null;
    if (!dialog) return;

    const onDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("keydown", onDialogKeyDown);
    return () => dialog.removeEventListener("keydown", onDialogKeyDown);
  }, [searchOpen, selectedAsset, contextDrawerOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (secretCountdown <= 0) return;
    const timer = window.setInterval(() => {
      setSecretCountdown((count) => {
        if (count <= 1) {
          setRevealedSecrets({});
          window.clearInterval(timer);
          return 0;
        }
        return count - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [secretCountdown]);

  const copyText = async (value: string, label = "Copied to clipboard") => {
    try {
      await navigator.clipboard.writeText(value);
      setToast(label);
    } catch {
      setToast("Copy is unavailable in this preview");
    }
  };

  const chooseView = (nextView: View) => {
    setView(nextView);
    setMobileNavOpen(false);
  };

  const toggleStep = (index: number) => {
    if (!isRunning) return;
    const key = `${selectedRunbook.id}-${index}`;
    const wasComplete = completedForRunbook.includes(key);
    const next = wasComplete
      ? completedForRunbook.filter((item) => item !== key)
      : [...completedForRunbook, key];
    setCompleted((current) => ({ ...current, [selectedRunbook.id]: next }));
    if (!wasComplete && next.length === selectedRunbook.steps.length) {
      setRunCompletedAt((current) => ({
        ...current,
        [selectedRunbook.id]: new Date().toISOString(),
      }));
    } else if (wasComplete) {
      setRunCompletedAt((current) => ({ ...current, [selectedRunbook.id]: "" }));
    }
  };

  const startRun = () => {
    setRunning((current) => ({ ...current, [selectedRunbook.id]: true }));
    setCompleted((current) => ({ ...current, [selectedRunbook.id]: [] }));
    setRunCompletedAt((current) => ({ ...current, [selectedRunbook.id]: "" }));
    setToast("Run started — your checklist is session-only");
  };

  const revealSecret = (id: string) => {
    setRevealedSecrets({ [id]: true });
    setSecretCountdown(30);
    setToast("Prototype reveal — this fictional value is not stored");
  };

  const openSearchRecord = (record: (typeof searchRecords)[number]) => {
    if (record.type === "Runbook") {
      setView("Runbooks");
      setSelectedRunbookId(record.target);
    } else if (record.type === "Asset") {
      setView("Assets");
      const asset = assets.find((item) => item.id === record.target);
      if (asset) setSelectedAsset(asset);
    } else if (record.type === "Secret") {
      setView("Secrets");
    } else {
      setView("Vendors");
    }
    setSearchOpen(false);
    setSearchQuery("");
    setSearchType("Everything");
    if (record.type !== "Asset") restoreFocus();
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSearchIndex((index) =>
        Math.min(index + 1, Math.max(filteredSearch.length - 1, 0)),
      );
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSearchIndex((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && filteredSearch[searchIndex]) {
      openSearchRecord(filteredSearch[searchIndex]);
    }
  };

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}
        inert={searchOpen || Boolean(selectedAsset) || contextDrawerOpen}
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <div>
            <strong>Rivet</strong>
            <span>IT operations</span>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <button className="sidebar-search" onClick={openSearch}>
          <Search size={16} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav className="primary-nav" aria-label="Primary navigation">
          <p className="nav-label">Workspace</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                className={view === item.label ? "nav-item active" : "nav-item"}
                onClick={() => chooseView(item.label)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
                {item.count ? <small>{item.count}</small> : null}
              </button>
            );
          })}
        </nav>

        <div className="client-nav">
          <p className="nav-label">Pinned clients</p>
          {clients.map((client) => (
            <button
              key={client.id}
              className={activeClient.id === client.id ? "client-item active" : "client-item"}
              onClick={() => {
                if (client.id !== "northstar") {
                  setToast(`${client.name} is outside this prototype dataset`);
                  return;
                }
                setActiveClient(client);
                setToast(`Scope confirmed: ${client.name}`);
              }}
            >
              <span className="client-monogram">{client.short}</span>
              <span>
                <strong>{client.name}</strong>
                <small>{client.status}</small>
              </span>
              <span className={`health-indicator health-${client.status.toLowerCase()}`} />
            </button>
          ))}
          <button
            className="all-clients"
            onClick={() => setToast("This prototype includes one complete client dataset")}
          >
            <Users size={15} />
            All clients
            <span>12</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <button
            className="nav-item"
            onClick={() => setToast("Recent activity is summarized in Client overview")}
          >
            <Activity size={16} />
            <span>Activity</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setToast("Shortcut: press ⌘K or Ctrl+K to search")}
          >
            <CircleHelp size={16} />
            <span>Help & shortcuts</span>
          </button>
          <div className="user-block">
            <span className="avatar">MC</span>
            <span>
              <strong>Maya Chen</strong>
              <small>Technician · Tier 2</small>
            </span>
            <MoreHorizontal size={16} />
          </div>
        </div>
      </aside>

      {mobileNavOpen ? (
        <button
          className="mobile-scrim"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}

      <div
        className="main-shell"
        inert={searchOpen || Boolean(selectedAsset) || contextDrawerOpen}
      >
        <header className="command-bar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span className="mobile-wordmark">RIVET</span>
            <span className="desktop-crumb">{activeClient.name}</span>
            <ChevronRight size={14} className="desktop-crumb" />
            <strong>{view}</strong>
          </div>

          <button className="command-search" onClick={openSearch}>
            <Search size={16} />
            <span>Search hostnames, IPs, runbooks, credentials…</span>
            <kbd>
              <Command size={11} /> K
            </kbd>
          </button>

          <div className="command-actions">
            <span className="environment">
              <span />
              Interactive prototype
            </span>
            <div className="new-record-wrap">
              <button
                className="primary-button compact"
                onClick={() => setNewMenuOpen((open) => !open)}
                aria-expanded={newMenuOpen}
              >
                <Plus size={15} />
                New
                <ChevronDown size={14} />
              </button>
              {newMenuOpen ? (
                <div className="new-menu">
                  <p>Create record</p>
                  {[
                    [FileText, "Runbook"],
                    [HardDrive, "Asset"],
                    [KeyRound, "Secret"],
                    [Archive, "Vendor"],
                  ].map(([Icon, label]) => {
                    const MenuIcon = Icon as LucideIcon;
                    return (
                      <button
                        key={label as string}
                        onClick={() => {
                          setNewMenuOpen(false);
                          setToast(
                            `Prototype only — ${String(label).toLowerCase()} creation is not connected`,
                          );
                        }}
                      >
                        <MenuIcon size={16} />
                        {label as string}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className={`workspace workspace-${view.toLowerCase()}`}>
          {view === "Runbooks" ? (
            <div className="runbook-workspace">
              <section className="record-list" aria-label="Runbooks">
                <div className="record-list-header">
                  <div>
                    <p className="coordinate">{activeClient.short} / KNOWLEDGE</p>
                    <h2>Runbooks</h2>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Clear runbook filter"
                    onClick={() => setRunbookFilter("")}
                  >
                    <Filter size={16} />
                  </button>
                </div>
                <label className="inline-filter">
                  <Search size={14} />
                  <input
                    aria-label="Filter runbooks"
                    placeholder="Filter runbooks…"
                    value={runbookFilter}
                    onChange={(event) => setRunbookFilter(event.target.value)}
                  />
                </label>
                <div className="record-list-body">
                  <p className="list-section-label">Recently used</p>
                  {filteredRunbooks.map((runbook) => (
                    <button
                      className={
                        selectedRunbook.id === runbook.id
                          ? "record-row selected"
                          : "record-row"
                      }
                      key={runbook.id}
                      onClick={() => setSelectedRunbookId(runbook.id)}
                    >
                      <span className="record-row-top">
                        <span>{runbook.code}</span>
                        <small>{runbook.updated}</small>
                      </span>
                      <strong>{runbook.title}</strong>
                      <span className="record-row-meta">
                        {runbook.group}
                        <span>·</span>
                        {runbook.duration}
                      </span>
                      <FreshnessBadge value={runbook.freshness} />
                    </button>
                  ))}
                  {!filteredRunbooks.length ? (
                    <p className="list-empty">No runbooks match “{runbookFilter}”.</p>
                  ) : null}
                </div>
                <button
                  className="record-list-footer"
                  onClick={() => setToast("All prototype runbooks are already shown")}
                >
                  <Archive size={15} />
                  Browse all 38 runbooks
                  <ArrowRight size={15} />
                </button>
              </section>

              <article className="runbook-reader">
                <header className="runbook-header">
                  <label className="mobile-runbook-select">
                    <span>Runbook</span>
                    <select
                      value={selectedRunbook.id}
                      onChange={(event) => setSelectedRunbookId(event.target.value)}
                    >
                      {runbooks.map((runbook) => (
                        <option value={runbook.id} key={runbook.id}>
                          {runbook.code} · {runbook.title}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </label>
                  <div className="runbook-path">
                    <span>{activeClient.name}</span>
                    <ChevronRight size={13} />
                    <span>{selectedRunbook.group}</span>
                    <ChevronRight size={13} />
                    <span>{selectedRunbook.code}</span>
                  </div>
                  <div className="runbook-title-row">
                    <div>
                      <h1>{selectedRunbook.title}</h1>
                      <p>{selectedRunbook.summary}</p>
                    </div>
                    <div className="runbook-actions">
                      {isRunning ? (
                        <span className="run-state">
                          <span />
                          Run in progress
                        </span>
                      ) : (
                        <button className="primary-button" onClick={startRun}>
                          <ListChecks size={16} />
                          Start run
                        </button>
                      )}
                      <button
                        className="secondary-button square-action"
                        aria-label="Edit runbook"
                        onClick={() =>
                          setToast("Prototype only — editing is not connected")
                        }
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="secondary-button square-action"
                        aria-label="More actions"
                        onClick={() => setToast("No additional actions in this prototype")}
                      >
                        <MoreHorizontal size={17} />
                      </button>
                      <button
                        className="secondary-button context-mobile-trigger"
                        onClick={openContextDrawer}
                      >
                        <Link2 size={15} />
                        Context
                      </button>
                    </div>
                  </div>
                  <div className="runbook-metadata">
                    <FreshnessBadge value={selectedRunbook.freshness} />
                    <span>{selectedRunbook.freshnessNote}</span>
                    <span className="metadata-rule" />
                    <span>{selectedRunbook.reviewNote}</span>
                    <span className="metadata-rule" />
                    <span>{selectedRunbook.duration}</span>
                  </div>
                  {isRunning ? (
                    <div className="run-progress" aria-label="Run progress">
                      <div>
                        <span>
                          {completedForRunbook.length} of {selectedRunbook.steps.length} complete
                        </span>
                        <strong>
                          {Math.round(
                            (completedForRunbook.length / selectedRunbook.steps.length) * 100,
                          )}
                          %
                        </strong>
                      </div>
                      <span className="progress-track">
                        <span
                          style={{
                            width: `${
                              (completedForRunbook.length / selectedRunbook.steps.length) * 100
                            }%`,
                          }}
                        />
                      </span>
                    </div>
                  ) : null}
                </header>

                <div className="runbook-content">
                  <div className="procedure-intro">
                    <span>Procedure</span>
                    <p>
                      Follow in order. Linked records open alongside this runbook so you
                      do not lose your place.
                    </p>
                  </div>
                  <ol className={isRunning ? "steps running" : "steps"}>
                    {selectedRunbook.steps.map((step, index) => {
                      const key = `${selectedRunbook.id}-${index}`;
                      const done = completedForRunbook.includes(key);
                      return (
                        <li key={step.title} className={done ? "step complete" : "step"}>
                          <button
                            className="step-marker"
                            onClick={() => toggleStep(index)}
                            disabled={!isRunning}
                            aria-label={
                              isRunning
                                ? `${done ? "Mark incomplete" : "Mark complete"}: ${step.title}`
                                : `Step ${index + 1}`
                            }
                          >
                            {done ? <Check size={15} /> : index + 1}
                          </button>
                          <div className="step-body">
                            <h2>{step.title}</h2>
                            <p>{step.body}</p>
                            {step.link ? (
                              <button
                                className="inline-link"
                                onClick={() =>
                                  setToast("Linked runbook preview is not included")
                                }
                              >
                                <FileText size={14} />
                                {step.link}
                                <ChevronRight size={13} />
                              </button>
                            ) : null}
                            {step.code ? (
                              <div className="code-block">
                                <code>{step.code}</code>
                                <button
                                  onClick={() => copyText(step.code ?? "", "Command copied")}
                                  aria-label="Copy command"
                                >
                                  <Copy size={14} />
                                  Copy
                                </button>
                              </div>
                            ) : null}
                            {step.warning ? (
                              <div className="warning-note">
                                <AlertTriangle size={15} />
                                <span>{step.warning}</span>
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>

                  {isFinished ? (
                    <div className="completion-panel">
                      <div className="completion-mark">
                        <CheckCircle2 size={19} />
                      </div>
                      <div>
                        <h2>Run complete</h2>
                        <p>
                          All steps are checked. Copy a clean completion note into the
                          service ticket.
                        </p>
                        <code>
                          Completed “{selectedRunbook.title}” for {activeClient.name} —{" "}
                          {selectedRunbook.steps.length}/{selectedRunbook.steps.length} steps
                          — {completionTime} — MC
                        </code>
                      </div>
                      <button
                        className="primary-button"
                        onClick={() =>
                          copyText(
                            `Completed “${selectedRunbook.title}” for ${activeClient.name} — ${selectedRunbook.steps.length}/${selectedRunbook.steps.length} steps — ${completionTime} — MC`,
                            "Ticket note copied",
                          )
                        }
                      >
                        <Clipboard size={15} />
                        Copy ticket note
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>

              <aside className="context-panel">
                <div className="context-header">
                  <div>
                    <p className="coordinate">LINKED CONTEXT</p>
                    <h2>At hand</h2>
                  </div>
                  <span className="context-state-icon" aria-hidden="true">
                    <PanelRight size={16} />
                  </span>
                </div>

                <div className="context-section">
                  <p className="context-label">Asset</p>
                  <button
                    className="linked-record"
                    onClick={() => openAsset(assets[0])}
                  >
                    <span className="linked-icon">
                      <Network size={15} />
                    </span>
                    <span>
                      <strong>NTD-FW-01</strong>
                      <small>PA-440 · 10.24.0.1</small>
                    </span>
                    <StatusDot status="Healthy" />
                  </button>
                </div>

                <div className="context-section">
                  <p className="context-label">Credential</p>
                  <div className="linked-secret">
                    <div>
                      <span className="linked-icon">
                        <LockKeyhole size={15} />
                      </span>
                      <span>
                        <strong>M365 Global Admin</strong>
                        <small>Restricted · fictional demo record</small>
                      </span>
                    </div>
                    {revealedSecrets["SEC-0048"] ? (
                      <div className="secret-reveal">
                        <code>{secrets[0].value}</code>
                        <div>
                          <span>Hides in {secretCountdown}s</span>
                          <button
                            onClick={() => copyText(secrets[0].value, "Fictional secret copied")}
                          >
                            <Copy size={13} />
                            Copy
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="text-button" onClick={() => revealSecret("SEC-0048")}>
                        <Eye size={14} />
                        Reveal 30s
                      </button>
                    )}
                  </div>
                </div>

                <div className="context-section">
                  <p className="context-label">Contact</p>
                  <button className="linked-record compact-record">
                    <span className="linked-icon">
                      <Users size={15} />
                    </span>
                    <span>
                      <strong>Leila Hassan</strong>
                      <small>Office Manager · approver</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                </div>

                <div className="context-section">
                  <p className="context-label">Related knowledge</p>
                  <button className="context-link">
                    <FileText size={14} />
                    <span>
                      <strong>Remote access overview</strong>
                      <small>DOC-007 · Verified</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                  <button className="context-link">
                    <FileText size={14} />
                    <span>
                      <strong>After-hours access policy</strong>
                      <small>POL-004 · Verified</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                </div>

                <div className="context-audit">
                  <p className="context-label">Record trail</p>
                  <div>
                    <span className="audit-line" />
                    <span>
                      <strong>Verified by Maya Chen</strong>
                      <small>Jul 18 · 09:42 AST</small>
                    </span>
                  </div>
                  <div>
                    <span className="audit-line" />
                    <span>
                      <strong>Step 4 clarified</strong>
                      <small>Jun 02 · Jules Stone</small>
                    </span>
                  </div>
                </div>
              </aside>
            </div>
          ) : null}

          {view === "Overview" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient.short} / CLIENT OVERVIEW`}
                title={activeClient.name}
                description="The operational facts, open risks, and recent changes technicians need before they touch the environment."
                action={
                  <button
                    className="secondary-button"
                    onClick={() => setToast("Prototype only — client editing is not connected")}
                  >
                    <Pencil size={15} />
                    Edit client
                  </button>
                }
              />
              <div className="fact-strip">
                {[
                  ["Documentation complete", "92%", "↑ 4% this month"],
                  ["Managed assets", "67", "64 reporting"],
                  ["Stored secrets", "14", "3 due to rotate"],
                  ["Open runbooks", "38", "36 verified"],
                ].map(([label, value, note]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                    <small>{note}</small>
                  </div>
                ))}
              </div>
              <div className="overview-grid">
                <section className="ledger-section attention-section">
                  <div className="ledger-heading">
                    <div>
                      <p className="coordinate">QUEUE / 03</p>
                      <h2>Needs attention</h2>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setToast("All three prototype items are already shown")}
                    >
                      View all
                    </button>
                  </div>
                  {[
                    ["Vendor renewal", "Fiber circuit notice window closes in 18 days", "VND-0023", "18d"],
                    ["Credential hygiene", "Three shared credentials are past rotation policy", "SEC / 03", "Overdue"],
                    ["Knowledge review", "Firewall credential runbook is overdue for review", "SOP-008", "6d"],
                  ].map(([type, title, id, time], index) => (
                    <button className="attention-row" key={title}>
                      <span className={`attention-index attention-${index + 1}`}>0{index + 1}</span>
                      <span>
                        <small>{type}</small>
                        <strong>{title}</strong>
                      </span>
                      <code>{id}</code>
                      <span className="attention-time">{time}</span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </section>
                <section className="ledger-section">
                  <div className="ledger-heading">
                    <div>
                      <p className="coordinate">RELATIONSHIPS</p>
                      <h2>Environment index</h2>
                    </div>
                  </div>
                  {[
                    ["Identity", "Microsoft 365", "67 users", "NTD-M365"],
                    ["Network edge", "Palo Alto PA-440", "Healthy", "NTD-FW-01"],
                    ["Directory", "Windows Server 2022", "Healthy", "NTD-DC-01"],
                    ["Backup", "Veeam + Synology", "Warning", "NTD-NAS-01"],
                  ].map(([kind, name, status, id]) => (
                    <button className="index-row" key={kind}>
                      <span>{kind}</span>
                      <strong>{name}</strong>
                      <small>{status}</small>
                      <code>{id}</code>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </section>
                <section className="ledger-section recent-section">
                  <div className="ledger-heading">
                    <div>
                      <p className="coordinate">AUDIT / 24H</p>
                      <h2>Recent work</h2>
                    </div>
                  </div>
                  {[
                    ["14:08", "Maya Chen", "opened", "Reset GlobalProtect MFA", "SOP-014"],
                    ["12:44", "Jules Stone", "updated", "NTD-LT-042", "AST-2184"],
                    ["10:16", "Maya Chen", "revealed", "Firewall break-glass", "SEC-0031"],
                    ["Yesterday", "Noah Reed", "verified", "New starter setup", "SOP-017"],
                  ].map(([time, person, action, record, id]) => (
                    <div className="activity-row" key={`${time}-${record}`}>
                      <time>{time}</time>
                      <span>
                        <strong>{person}</strong> {action} <b>{record}</b>
                      </span>
                      <code>{id}</code>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          ) : null}

          {view === "Assets" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient.short} / ASSETS / 67`}
                title="Assets"
                description="Devices, infrastructure, ownership, and the records linked to each system."
                action={
                  <>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        setToast("Prototype only — CSV import is not connected")
                      }
                    >
                      <Database size={15} />
                      Import CSV
                    </button>
                    <button
                      className="primary-button"
                      onClick={() =>
                        setToast("Prototype only — asset creation is not connected")
                      }
                    >
                      <Plus size={15} />
                      Add asset
                    </button>
                  </>
                }
              />
              <div className="table-toolbar">
                <label>
                  <Search size={15} />
                  <input
                    placeholder="Search name, IP, serial, owner…"
                    value={assetQuery}
                    onChange={(event) => setAssetQuery(event.target.value)}
                  />
                </label>
                <span>{filteredAssets.length} of 67 shown</span>
              </div>
              <div className="data-table asset-table">
                <div className="table-head">
                  <span>Asset</span>
                  <span>Type</span>
                  <span>Address</span>
                  <span>Owner</span>
                  <span>Status</span>
                  <span>Last seen</span>
                  <span />
                </div>
                {filteredAssets.map((asset) => (
                  <button
                    className="table-row"
                    key={asset.id}
                    onClick={() => openAsset(asset)}
                  >
                    <span className="primary-cell">
                      <span className="asset-symbol">
                        {asset.type.includes("Server") ? <Server size={16} /> : <Laptop size={16} />}
                      </span>
                      <span>
                        <strong>{asset.name}</strong>
                        <code>{asset.id}</code>
                      </span>
                    </span>
                    <span data-label="Type">{asset.type}</span>
                    <code data-label="Address">{asset.address}</code>
                    <span data-label="Owner">{asset.owner}</span>
                    <span data-label="Status">
                      <StatusDot status={asset.status} />
                    </span>
                    <span data-label="Last seen">{asset.seen}</span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {view === "Secrets" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient.short} / VAULT / 14`}
                title="Secrets"
                description="Discover credentials by relationship. Plaintext values never appear in search results or exports."
                action={
                  <button
                    className="primary-button"
                    onClick={() =>
                      setToast("Prototype only — secret creation is not connected")
                    }
                  >
                    <Plus size={15} />
                    Add secret
                  </button>
                }
              />
              <div className="security-banner">
                <ShieldCheck size={18} />
                <div>
                  <strong>Prototype vault behavior</strong>
                  <span>
                    All credentials are fictional and no data is stored. Production
                    requires server-side encryption and persistent audit logging.
                  </span>
                </div>
                <button
                  className="text-button"
                  onClick={() =>
                    setToast("Security architecture is outside this interface prototype")
                  }
                >
                  View security model
                </button>
              </div>
              <div className="table-toolbar">
                <label>
                  <Search size={15} />
                  <input
                    placeholder="Search credential names or linked records…"
                    value={secretQuery}
                    onChange={(event) => setSecretQuery(event.target.value)}
                  />
                </label>
                <span>{filteredSecrets.length} of 14 shown</span>
              </div>
              <div className="secret-ledger">
                {filteredSecrets.map((secret) => {
                  const isRevealed = revealedSecrets[secret.id];
                  return (
                    <div className="secret-row" key={secret.id}>
                      <div className="secret-identity">
                        <span className="asset-symbol">
                          <FileKey size={16} />
                        </span>
                        <span>
                          <strong>{secret.name}</strong>
                          <code>{secret.id}</code>
                        </span>
                      </div>
                      <div>
                        <small>Linked to</small>
                        <strong>{secret.linked}</strong>
                      </div>
                      <div>
                        <small>Access</small>
                        <strong>{secret.access}</strong>
                      </div>
                      <div>
                        <small>Last rotated</small>
                        <strong>{secret.rotated}</strong>
                      </div>
                      <div className="secret-value-cell">
                        <small>Secret value</small>
                        <code>{isRevealed ? secret.value : "•••• •••• •••• ••••"}</code>
                      </div>
                      <div className="secret-actions">
                        {isRevealed ? (
                          <>
                            <button
                              className="secondary-button"
                              onClick={() => {
                                setRevealedSecrets({});
                                setSecretCountdown(0);
                              }}
                            >
                              <EyeOff size={14} />
                              Hide
                            </button>
                            <button
                              className="primary-button"
                              onClick={() =>
                                copyText(secret.value, "Fictional secret copied")
                              }
                            >
                              <Copy size={14} />
                              Copy
                            </button>
                          </>
                        ) : (
                          <button
                            className="secondary-button"
                            onClick={() => revealSecret(secret.id)}
                          >
                            <Eye size={14} />
                            Reveal 30s
                          </button>
                        )}
                      </div>
                      {isRevealed ? (
                        <span className="secret-audit-note">
                          Visible for {secretCountdown}s · simulated access event only
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {view === "Vendors" ? (
            <div className="standard-view">
              <SectionHeader
                eyebrow={`${activeClient.short} / VENDORS / 08`}
                title="Vendors & contracts"
                description="Support paths, renewal dates, notice periods, and the systems each agreement covers."
                action={
                  <button
                    className="primary-button"
                    onClick={() =>
                      setToast("Prototype only — vendor creation is not connected")
                    }
                  >
                    <Plus size={15} />
                    Add vendor
                  </button>
                }
              />
              <div className="table-toolbar">
                <label>
                  <Search size={15} />
                  <input
                    placeholder="Search vendor, service, or owner…"
                    value={vendorQuery}
                    onChange={(event) => setVendorQuery(event.target.value)}
                  />
                </label>
                <span>{filteredVendors.length} of 8 shown</span>
              </div>
              <div className="data-table vendor-table">
                <div className="table-head">
                  <span>Vendor</span>
                  <span>Service</span>
                  <span>Renewal</span>
                  <span>Notice</span>
                  <span>Owner</span>
                  <span>Status</span>
                  <span />
                </div>
                {filteredVendors.map((vendor) => (
                  <button className="table-row" key={vendor.id}>
                    <span className="primary-cell">
                      <span className="asset-symbol">
                        <Archive size={16} />
                      </span>
                      <span>
                        <strong>{vendor.name}</strong>
                        <code>{vendor.id}</code>
                      </span>
                    </span>
                    <span data-label="Service">{vendor.service}</span>
                    <time data-label="Renewal">{vendor.renewal}</time>
                    <span data-label="Notice">{vendor.notice}</span>
                    <span data-label="Owner">{vendor.owner}</span>
                    <span data-label="Status">
                      <StatusDot status={vendor.status} />
                    </span>
                    <ExternalLink size={14} />
                  </button>
                ))}
              </div>
              <div className="renewal-note">
                <Clock3 size={16} />
                <span>
                  <strong>One agreement needs attention.</strong> Gulf Data Systems is
                  inside its 45-day notice window.
                </span>
                <button>Open renewal queue</button>
              </div>
            </div>
          ) : null}
        </main>

        <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                className={view === item.label ? "active" : ""}
                onClick={() => chooseView(item.label)}
              >
                <Icon size={19} />
                <span>{item.label === "Overview" ? "Client" : item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {searchOpen ? (
        <div className="modal-backdrop" onMouseDown={closeSearch}>
          <div
            ref={searchDialogRef}
            className="search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search workspace"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="search-input-row">
              <Search size={20} />
              <input
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls="workspace-search-results"
                aria-activedescendant={
                  filteredSearch[searchIndex] ? `search-option-${searchIndex}` : undefined
                }
                aria-autocomplete="list"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchIndex(0);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder="Search hostnames, IPs, runbooks, credentials…"
              />
              <kbd>ESC</kbd>
            </div>
            <div className="search-scope-row">
              <span>
                {activeClient.name}
                <X size={12} />
              </span>
              {[
                ["Everything", "Everything"],
                ["Runbooks", "Runbook"],
                ["Assets", "Asset"],
                ["Secrets", "Secret"],
                ["Vendors", "Vendor"],
              ].map(([label, type]) => (
                <button
                  key={type}
                  className={searchType === type ? "active" : ""}
                  onClick={() => {
                    setSearchType(type);
                    setSearchIndex(0);
                  }}
                >
                  {label}
                  {type === "Everything" ? ` ${searchRecords.length}` : ""}
                </button>
              ))}
            </div>
            <div className="search-results" id="workspace-search-results" role="listbox">
              <div className="search-results-heading">
                <span>
                  {searchQuery
                    ? `${filteredSearch.length} results for “${searchQuery}”`
                    : "Recently used and suggested"}
                </span>
                <span>↑↓ select · ↵ open</span>
              </div>
              {filteredSearch.length ? (
                filteredSearch.map((record, index) => {
                  const Icon =
                    record.type === "Runbook"
                      ? FileText
                      : record.type === "Asset"
                        ? HardDrive
                        : record.type === "Secret"
                          ? LockKeyhole
                          : Archive;
                  return (
                    <button
                      id={`search-option-${index}`}
                      role="option"
                      aria-selected={searchIndex === index}
                      className={searchIndex === index ? "search-result active" : "search-result"}
                      key={`${record.type}-${record.title}`}
                      onMouseEnter={() => setSearchIndex(index)}
                      onClick={() => openSearchRecord(record)}
                    >
                      <span className="search-result-icon">
                        <Icon size={17} />
                      </span>
                      <span className="search-result-copy">
                        <span>
                          <strong>{record.title}</strong>
                          <em>{record.type}</em>
                        </span>
                        <small>{record.path}</small>
                        <p>{record.excerpt}</p>
                      </span>
                      <span className="search-result-meta">{record.meta}</span>
                      <ChevronRight size={15} />
                    </button>
                  );
                })
              ) : (
                <div className="search-empty">
                  <Search size={22} />
                  <strong>No records match that search</strong>
                  <p>Try a hostname, IP address, record ID, vendor, or user name.</p>
                </div>
              )}
            </div>
            <div className="search-footer">
              <span>
                <LockKeyhole size={13} />
                Fictional secret values are excluded from search
              </span>
              <button>
                <Sparkles size={13} />
                Search help
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedAsset ? (
        <div className="drawer-backdrop" onMouseDown={closeAsset}>
          <aside
            ref={assetDrawerRef}
            className="asset-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-drawer-title"
            onMouseDown={(event) => event.stopPropagation()}
            aria-label={`${selectedAsset.name} details`}
          >
            <header>
              <div>
                <p className="coordinate">{selectedAsset.id}</p>
                <h2 id="asset-drawer-title">{selectedAsset.name}</h2>
              </div>
              <button
                className="icon-button"
                onClick={closeAsset}
                aria-label="Close asset details"
                autoFocus
              >
                <X size={18} />
              </button>
            </header>
            <div className="drawer-status">
              <StatusDot status={selectedAsset.status} />
              <span>Last seen {selectedAsset.seen}</span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Type</dt>
                <dd>{selectedAsset.type}</dd>
              </div>
              <div>
                <dt>IP address</dt>
                <dd>
                  <code>{selectedAsset.address}</code>
                  <button
                    onClick={() => copyText(selectedAsset.address, "IP address copied")}
                    aria-label="Copy IP address"
                  >
                    <Copy size={13} />
                  </button>
                </dd>
              </div>
              <div>
                <dt>Serial / ID</dt>
                <dd>
                  <code>{selectedAsset.serial}</code>
                </dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{selectedAsset.owner}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>{selectedAsset.location}</dd>
              </div>
            </dl>
            <section className="drawer-section">
              <p className="context-label">Linked records</p>
              <button className="context-link">
                <FileText size={14} />
                <span>
                  <strong>Reset GlobalProtect MFA</strong>
                  <small>SOP-014 · Verified</small>
                </span>
                <ChevronRight size={14} />
              </button>
              <button className="context-link">
                <KeyRound size={14} />
                <span>
                  <strong>Firewall break-glass</strong>
                  <small>SEC-0031 · Restricted</small>
                </span>
                <ChevronRight size={14} />
              </button>
            </section>
            <div className="drawer-actions">
              <button className="secondary-button">
                <Pencil size={15} />
                Edit asset
              </button>
              <button className="primary-button">
                Open full record
                <ArrowRight size={15} />
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {contextDrawerOpen ? (
        <div className="drawer-backdrop" onMouseDown={closeContextDrawer}>
          <aside
            ref={contextDrawerRef}
            className="context-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="context-drawer-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="coordinate">LINKED CONTEXT</p>
                <h2 id="context-drawer-title">At hand</h2>
              </div>
              <button
                className="icon-button"
                onClick={closeContextDrawer}
                aria-label="Close linked context"
                autoFocus
              >
                <X size={18} />
              </button>
            </header>
            <div className="context-drawer-body">
              <div className="context-section">
                <p className="context-label">Asset</p>
                <button
                  className="linked-record"
                  onClick={() => {
                    setContextDrawerOpen(false);
                    setSelectedAsset(assets[0]);
                  }}
                >
                  <span className="linked-icon">
                    <Network size={15} />
                  </span>
                  <span>
                    <strong>NTD-FW-01</strong>
                    <small>PA-440 · 10.24.0.1</small>
                  </span>
                  <StatusDot status="Healthy" />
                </button>
              </div>
              <div className="context-section">
                <p className="context-label">Credential</p>
                <div className="linked-secret">
                  <div>
                    <span className="linked-icon">
                      <LockKeyhole size={15} />
                    </span>
                    <span>
                      <strong>M365 Global Admin</strong>
                      <small>Restricted · fictional demo record</small>
                    </span>
                  </div>
                  {revealedSecrets["SEC-0048"] ? (
                    <div className="secret-reveal">
                      <code>{secrets[0].value}</code>
                      <div>
                        <span>Hides in {secretCountdown}s</span>
                        <button
                          onClick={() =>
                            copyText(secrets[0].value, "Fictional secret copied")
                          }
                        >
                          <Copy size={13} />
                          Copy
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => revealSecret("SEC-0048")}
                    >
                      <Eye size={14} />
                      Reveal 30s
                    </button>
                  )}
                </div>
              </div>
              <div className="context-section">
                <p className="context-label">Contact</p>
                <div className="linked-record compact-record">
                  <span className="linked-icon">
                    <Users size={15} />
                  </span>
                  <span>
                    <strong>Leila Hassan</strong>
                    <small>Office Manager · approver</small>
                  </span>
                </div>
              </div>
              <div className="context-section">
                <p className="context-label">Related knowledge</p>
                <button className="context-link">
                  <FileText size={14} />
                  <span>
                    <strong>Remote access overview</strong>
                    <small>DOC-007 · Verified</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
                <button className="context-link">
                  <FileText size={14} />
                  <span>
                    <strong>After-hours access policy</strong>
                    <small>POL-004 · Verified</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      <div className={toast ? "toast visible" : "toast"} role="status" aria-live="polite">
        <CheckCircle2 size={16} />
        {toast}
      </div>
    </div>
  );
}
