import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, findWorkspace, newWorkspaceId, pickWorkspace, type SlackFlavorSettings } from "../src/settings";
import { createStrings } from "../src/i18n";

const settings: SlackFlavorSettings = {
  ...DEFAULT_SETTINGS,
  workspaces: [
    { id: "ws-a", name: "Acme", secret: "slack-acme", domain: "acme.slack.com", teamId: "T1" },
    { id: "ws-b", name: "Personal", secret: "slack-me", domain: "me-team.slack.com" },
  ],
  defaultWorkspace: "ws-b",
};

describe("findWorkspace", () => {
  it("matches id, name (any case), domain, subdomain and team id", () => {
    for (const ref of ["ws-a", "acme", "Acme", "acme.slack.com", "T1"]) {
      expect(findWorkspace(settings, ref)?.id).toBe("ws-a");
    }
    expect(findWorkspace(settings, "me-team")?.id).toBe("ws-b");
  });

  it("returns undefined for unknown or empty refs", () => {
    expect(findWorkspace(settings, "nope")).toBeUndefined();
    expect(findWorkspace(settings, "")).toBeUndefined();
    expect(findWorkspace(settings, undefined)).toBeUndefined();
  });
});

describe("pickWorkspace", () => {
  it("prefers the block, then the note, then the default", () => {
    expect(pickWorkspace(settings, "acme", "Personal")?.id).toBe("ws-a");
    expect(pickWorkspace(settings, undefined, "acme")?.id).toBe("ws-a");
    expect(pickWorkspace(settings, undefined, undefined)?.id).toBe("ws-b");
  });

  it("does not fall back when the block names an unknown workspace", () => {
    expect(pickWorkspace(settings, "unknown", "acme")).toBeUndefined();
  });

  it("uses the first workspace when no default is set", () => {
    expect(pickWorkspace({ ...settings, defaultWorkspace: null })?.id).toBe("ws-a");
    expect(pickWorkspace({ ...settings, defaultWorkspace: "gone" })?.id).toBe("ws-a");
  });
});

describe("newWorkspaceId", () => {
  it("creates a file-safe id not already in use", () => {
    const id = newWorkspaceId(settings.workspaces);
    expect(id).toMatch(/^ws-[a-z0-9]+$/);
    expect(settings.workspaces.map((w) => w.id)).not.toContain(id);
  });
});

describe("createStrings", () => {
  it("uses Japanese for ja and English otherwise", () => {
    expect(createStrings("ja").replies(2)).toBe("2件の返信");
    expect(createStrings("en").replies(1)).toBe("1 reply");
    expect(createStrings("fr").replies(3)).toBe("3 replies");
  });
});
