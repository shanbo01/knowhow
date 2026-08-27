"use client";

import { Check, Globe2, Link2, LockKeyhole, Search, Users, X } from "lucide-react";
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

export function isAnyoneWithLink(audiences: Audience[]) {
  return audiences.some((item) => item.kind === "link");
}

/**
 * Audience is one decision with two shapes — everyone, or a named list — so it
 * reads as two choices rather than a checkbox that silently reveals a picker.
 * The list deliberately does not scroll on its own: the dialog body is the
 * only scroll region, because nesting one inside another made it impossible to
 * tell which pane the wheel was going to move.
 */
export function GuideAudiencePicker({
  workspaceName,
  audiences,
  groups,
  members,
  allowPrivate = false,
  onChange,
}: {
  workspaceName: string;
  audiences: Audience[];
  groups: WorkspaceGroup[];
  members: WorkspaceMember[];
  allowPrivate?: boolean;
  onChange: (audiences: Audience[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [choosingSpecific, setChoosingSpecific] = useState(() =>
    audiences.some((item) => item.kind === "group" || item.kind === "user"),
  );
  const workspaceSelected = isEntireWorkspace(audiences);
  const linkSelected = isAnyoneWithLink(audiences);
  const hasNamedAudience = audiences.some(
    (item) => item.kind === "group" || item.kind === "user",
  );
  const specificSelected = hasNamedAudience || (choosingSpecific && !audiences.length);
  const privateSelected = !audiences.length && !specificSelected;

  const query = search.trim().toLowerCase();
  const filteredGroups = useMemo(
    () =>
      groups.filter((group) => !query || group.name.toLowerCase().includes(query)),
    [groups, query],
  );
  const filteredMembers = useMemo(
    () =>
      members.filter((member) => {
        if (member.status !== "active") return false;
        if (!query) return true;
        return (
          member.name.toLowerCase().includes(query) ||
          member.email.toLowerCase().includes(query)
        );
      }),
    [members, query],
  );

  const chosen = audiences.filter(
    (item) => item.kind === "group" || item.kind === "user",
  );

  function selectWorkspace() {
    setChoosingSpecific(false);
    onChange([workspaceAudience()]);
  }

  function selectSpecific() {
    setChoosingSpecific(true);
    if (!specificSelected) onChange([]);
  }

  function selectLink() {
    setChoosingSpecific(false);
    const current = audiences.find((item) => item.kind === "link");
    onChange([
      current ?? { kind: "link", label: "Anyone with the link" },
    ]);
  }

  function selectPrivate() {
    setChoosingSpecific(false);
    onChange([]);
  }

  function toggle(kind: "group" | "user", subjectId: string, label: string) {
    const withoutWorkspace = audiences.filter(
      (item) => item.kind !== "workspace",
    );
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

  function isChosen(kind: "group" | "user", subjectId: string) {
    return audiences.some(
      (item) => item.kind === kind && item.subjectId === subjectId,
    );
  }

  return (
    <div className="audience-picker">
      <div className="audience-modes" role="radiogroup" aria-label="Guide access">
        {allowPrivate ? (
          <button
            type="button"
            role="radio"
            aria-checked={privateSelected}
            className="audience-mode"
            data-selected={privateSelected}
            onClick={selectPrivate}
          >
            <span className="audience-mode-icon"><LockKeyhole /></span>
            <span>
              <strong>Not shared</strong>
              <small>Only editors can open this guide</small>
            </span>
            {privateSelected ? <Check className="audience-mode-tick" /> : null}
          </button>
        ) : null}
        <button
          type="button"
          role="radio"
          aria-checked={workspaceSelected}
          className="audience-mode"
          data-selected={workspaceSelected}
          onClick={selectWorkspace}
        >
          <span className="audience-mode-icon"><Globe2 /></span>
          <span>
            <strong>Entire workspace</strong>
            <small>Every signed-in member of {workspaceName}</small>
          </span>
          {workspaceSelected ? <Check className="audience-mode-tick" /> : null}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={specificSelected}
          className="audience-mode"
          data-selected={specificSelected}
          onClick={selectSpecific}
        >
          <span className="audience-mode-icon"><Users /></span>
          <span>
            <strong>Specific groups and people</strong>
            <small>Only the ones you name below</small>
          </span>
          {specificSelected ? <Check className="audience-mode-tick" /> : null}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={linkSelected}
          className="audience-mode"
          data-selected={linkSelected}
          onClick={selectLink}
        >
          <span className="audience-mode-icon"><Link2 /></span>
          <span>
            <strong>Anyone with the link</strong>
            <small>No sign-in required; link stays unlisted</small>
          </span>
          {linkSelected ? <Check className="audience-mode-tick" /> : null}
        </button>
      </div>

      {specificSelected ? (
        <div className="audience-choose">
          {chosen.length ? (
            <div className="audience-chosen" aria-live="polite">
              {chosen.map((item) => (
                <button
                  type="button"
                  className="audience-chip"
                  key={`${item.kind}:${item.subjectId}`}
                  aria-label={`Remove ${item.label || item.subjectId}`}
                  onClick={() =>
                    toggle(
                      item.kind === "group" ? "group" : "user",
                      item.subjectId ?? "",
                      item.label ?? "",
                    )
                  }
                >
                  {item.label || item.subjectId} <X />
                </button>
              ))}
            </div>
          ) : null}

          <label className="audience-search">
            <Search />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search groups and people"
              aria-label="Search groups and people"
            />
          </label>

          <div className="audience-results">
            <p className="audience-group-label">Groups</p>
            {filteredGroups.length ? (
              filteredGroups.map((group) => {
                const selected = isChosen("group", group.id);
                const unavailable = group.memberCount === 0 && !selected;
                return (
                  <label
                    className={`choice-row${unavailable ? " unavailable-choice" : ""}`}
                    key={group.id}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={unavailable}
                      onChange={() => toggle("group", group.id, group.name)}
                    />
                    <span>
                      <strong>{group.name}</strong>
                      <small>
                        {group.memberCount === 0
                          ? "No members yet"
                          : `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`}
                        {group.sensitive ? " · Restricted membership" : ""}
                      </small>
                    </span>
                  </label>
                );
              })
            ) : (
              <p className="audience-empty">No matching groups</p>
            )}

            <p className="audience-group-label">People</p>
            {filteredMembers.length ? (
              filteredMembers.map((member) => (
                <label className="choice-row" key={member.id}>
                  <input
                    type="checkbox"
                    checked={isChosen("user", member.userId)}
                    onChange={() =>
                      toggle("user", member.userId, member.name || member.email)
                    }
                  />
                  <span>
                    <strong>{member.name || member.email}</strong>
                    <small>{member.email}</small>
                  </span>
                </label>
              ))
            ) : (
              <p className="audience-empty">No matching people</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
