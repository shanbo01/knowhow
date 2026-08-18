"use client";

import { Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  Audience,
  WorkspaceGroup,
  WorkspaceMember,
} from "../../lib/knowhow-types";

export function workspaceAudience(): Audience {
  return { kind: "workspace", label: "Entire workspace" };
}

export function isEntireWorkspace(audiences: Audience[]) {
  return audiences.some((item) => item.kind === "workspace");
}

export function GuideAudiencePicker({
  workspaceName,
  audiences,
  groups,
  members,
  onChange,
}: {
  workspaceName: string;
  audiences: Audience[];
  groups: WorkspaceGroup[];
  members: WorkspaceMember[];
  onChange: (audiences: Audience[]) => void;
}) {
  const [groupSearch, setGroupSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const workspaceSelected = isEntireWorkspace(audiences);
  const filteredGroups = useMemo(() => {
    const query = groupSearch.trim().toLowerCase();
    return groups.filter((group) =>
      !query || group.name.toLowerCase().includes(query),
    );
  }, [groupSearch, groups]);
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    return members.filter((member) => {
      if (member.status !== "active") return false;
      if (!query) return true;
      return (
        member.name.toLowerCase().includes(query) ||
        member.email.toLowerCase().includes(query)
      );
    });
  }, [memberSearch, members]);
  const restrictedLabels = audiences
    .filter((item) => item.kind !== "workspace")
    .map((item) => item.label || item.subjectId)
    .filter(Boolean);

  function setWorkspace(enabled: boolean) {
    onChange(enabled ? [workspaceAudience()] : []);
  }

  function toggle(kind: "group" | "user", subjectId: string, label: string) {
    const withoutWorkspace = audiences.filter((item) => item.kind !== "workspace");
    const exists = withoutWorkspace.some(
      (item) => item.kind === kind && item.subjectId === subjectId,
    );
    onChange(
      exists
        ? withoutWorkspace.filter(
            (item) => !(item.kind === kind && item.subjectId === subjectId),
          )
        : [...withoutWorkspace, { kind, subjectId, label }],
    );
  }

  return (
    <div className="guide-audience-picker">
      <label className="choice-row emphasized">
        <input
          type="checkbox"
          checked={workspaceSelected}
          onChange={(event) => setWorkspace(event.target.checked)}
        />
        <span>
          <strong>Entire workspace</strong>
          <small>Signed-in members of {workspaceName} can view</small>
        </span>
      </label>
      {!workspaceSelected ? (
        <div className="audience-picker-scroll">
          <div className="choice-section">
            <span className="field-label">Groups</span>
            <label className="audience-search">
              <Search />
              <input
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
                placeholder="Search groups"
                aria-label="Search groups"
              />
            </label>
            <div className="audience-option-list">
              {filteredGroups.map((group) => (
                <label className="choice-row" key={group.id}>
                  <input
                    type="checkbox"
                    checked={audiences.some(
                      (item) => item.kind === "group" && item.subjectId === group.id,
                    )}
                    onChange={() => toggle("group", group.id, group.name)}
                  />
                  <span>
                    <strong>{group.name}</strong>
                    <small>
                      {group.sensitive
                        ? "Sensitive group"
                        : `${group.memberCount} members`}
                    </small>
                  </span>
                </label>
              ))}
              {!filteredGroups.length ? (
                <p className="audience-empty">No matching groups</p>
              ) : null}
            </div>
          </div>
          <details className="audience-people" open>
            <summary>Named people</summary>
            <label className="audience-search">
              <Search />
              <input
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
                placeholder="Search people"
                aria-label="Search people"
              />
            </label>
            <div className="audience-option-list">
              {filteredMembers.map((member) => (
                <label className="choice-row" key={member.id}>
                  <input
                    type="checkbox"
                    checked={audiences.some(
                      (item) =>
                        item.kind === "user" && item.subjectId === member.userId,
                    )}
                    onChange={() =>
                      toggle("user", member.userId, member.name || member.email)
                    }
                  />
                  <span>
                    <strong>{member.name || member.email}</strong>
                    <small>{member.email}</small>
                  </span>
                </label>
              ))}
              {!filteredMembers.length ? (
                <p className="audience-empty">No matching people</p>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}
      {!audiences.length ? (
        <p className="inline-warning">
          <TriangleAlert /> Select who can view this guide
        </p>
      ) : null}
      {restrictedLabels.length ? (
        <p className="privacy-caption">
          <ShieldCheck /> Restricted to {restrictedLabels.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
