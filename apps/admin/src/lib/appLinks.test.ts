import { describe, expect, it, vi } from "vitest";
import { appDestinations, destinationsForRoles, devAddress, handoverText } from "./appLinks.js";

const DASHBOARD = "https://admin.example.test";

describe("handover addresses", () => {
  it("defaults the dashboard to the origin serving it", () => {
    expect(appDestinations(DASHBOARD)[0]).toMatchObject({
      key: "admin",
      url: DASHBOARD,
    });
  });

  it("reports an unset address rather than guessing one", () => {
    const field = appDestinations(DASHBOARD, false).find(
      (destination) => destination.key === "field",
    );
    expect(field?.url).toBeUndefined();
  });

  it("points a development build at the sibling dev servers", () => {
    // `pnpm dev` runs the three apps side by side, so a handover card on a LAN
    // address hands out the same host on the app's own port.
    const destinations = appDestinations("http://192.168.0.183:5173", true);
    expect(destinations.find((destination) => destination.key === "field")?.url).toBe(
      "http://192.168.0.183:5174",
    );
    expect(destinations.find((destination) => destination.key === "collector")?.url).toBe(
      "http://192.168.0.183:5175",
    );
  });

  it("keeps a configured address even in a development build", () => {
    vi.stubEnv("VITE_FIELD_APP_URL", "https://field.example.test");
    try {
      const destinations = appDestinations("http://localhost:5173", true);
      expect(destinations.find((destination) => destination.key === "field")?.url).toBe(
        "https://field.example.test",
      );
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("dev addresses", () => {
  it("swaps the port and keeps the host a phone typed", () => {
    expect(devAddress("field", "http://192.168.0.183:5173")).toBe("http://192.168.0.183:5174");
    expect(devAddress("collector", "http://localhost:5173")).toBe("http://localhost:5175");
  });

  it("says it does not know rather than throwing on a nonsense origin", () => {
    expect(devAddress("field", "not a url")).toBeUndefined();
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
