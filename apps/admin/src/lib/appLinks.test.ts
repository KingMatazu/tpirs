import { describe, expect, it } from "vitest";
import { appDestinations, destinationsForRoles, handoverText } from "./appLinks.js";

const DASHBOARD = "https://admin.example.test";

describe("handover addresses", () => {
  it("defaults the dashboard to the origin serving it", () => {
    expect(appDestinations(DASHBOARD)[0]).toMatchObject({
      key: "admin",
      url: DASHBOARD,
    });
  });

  it("reports an unset address rather than guessing one", () => {
    const field = appDestinations(DASHBOARD).find((destination) => destination.key === "field");
    expect(field?.url).toBeUndefined();
  });

  it("sends officers and collectors to their own apps", () => {
    const destinations = appDestinations(DASHBOARD);
    expect(destinationsForRoles(["officer"], destinations).map((entry) => entry.key)).toEqual([
      "field",
    ]);
    expect(destinationsForRoles(["collector"], destinations).map((entry) => entry.key)).toEqual([
      "collector",
    ]);
  });

  it("keeps every role that works in the dashboard there", () => {
    const destinations = appDestinations(DASHBOARD);
    for (const role of ["finance_admin", "system_admin", "auditor", "zone_supervisor", "unknown"]) {
      expect(destinationsForRoles([role], destinations).map((entry) => entry.key)).toEqual([
        "admin",
      ]);
    }
  });

  it("offers both addresses to a person who needs both", () => {
    const destinations = appDestinations(DASHBOARD);
    expect(
      destinationsForRoles(["collector", "finance_admin"], destinations).map((entry) => entry.key),
    ).toEqual(["admin", "collector"]);
  });

  it("falls back to the dashboard when no role was chosen", () => {
    expect(destinationsForRoles([], appDestinations(DASHBOARD)).map((entry) => entry.key)).toEqual([
      "admin",
    ]);
  });
});

describe("handover message", () => {
  const details = {
    displayName: "Aisha Bello",
    username: "aisha.officer",
    password: "temp-pass-1",
    slug: "katsina-state",
  };

  it("repeats what the sign-in form asks for, in that order", () => {
    const text = handoverText(details, [
      { key: "field", label: "Officer app", url: "https://field.example.test" },
    ]);
    expect(text).toContain("https://field.example.test");
    expect(text).toContain("State: katsina-state");
    expect(text).toContain("Username: aisha.officer");
    expect(text).toContain("Temporary password: temp-pass-1");
    expect(text).toContain("choose your own password");
  });

  it("labels the address when there is more than one", () => {
    const text = handoverText(details, [
      { key: "admin", label: "Dashboard", url: DASHBOARD },
      { key: "collector", label: "Collector app", url: "https://collector.example.test" },
    ]);
    expect(text).toContain("Sign in at (Dashboard): https://admin.example.test");
    expect(text).toContain("Sign in at (Collector app): https://collector.example.test");
  });

  it("does not invent a password it does not have", () => {
    const text = handoverText(
      { displayName: details.displayName, username: details.username, slug: details.slug },
      [],
    );
    expect(text).toContain("Temporary password: ask the administrator who created the account");
  });
});
