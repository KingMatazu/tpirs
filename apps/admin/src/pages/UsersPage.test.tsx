import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import {
  UsersPage,
  roleNames,
  toggleRole,
  type RoleOption,
  type StaffAccount,
} from "./UsersPage.js";

/**
 * Staff accounts (11.0b). The screen must create an account with the exact body
 * the API validates, map server issues back to fields, disable an account, reset
 * a password, and hide every editor from a read-only account administrator.
 */

const requests: { method: string; path: string; body: string }[] = [];

let accounts: StaffAccount[] = [];
let issuesForCreate: { path: string; message: string }[] = [];

const roles: RoleOption[] = [
  { key: "finance_admin", name: "Finance Admin", permissions: ["payment:read"] },
  { key: "officer", name: "Field Officer", permissions: ["scan:record"] },
  { key: "collector", name: "Collector", permissions: ["cash:intake"] },
];

const fakeFetch = vi.fn(async (input: unknown) => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  requests.push({
    method: request.method,
    path: url.pathname,
    body: await request.clone().text(),
  });

  if (request.method === "GET" && url.pathname === "/v1/users") {
    return json(200, { users: accounts });
  }
  if (request.method === "GET" && url.pathname === "/v1/roles") {
    return json(200, { roles });
  }
  if (request.method === "GET" && url.pathname === "/v1/tenants/current/config") {
    // Only the slug and the collector rule are read by this screen; the rest of
    // the config is the config viewer's business.
    return json(200, {
      config: {
        identity: { slug: "katsina-state" },
        collectors: { nationalIdPattern: "^\\d{11}$" },
      },
      version: 1,
    });
  }
  if (request.method === "POST" && url.pathname === "/v1/users") {
    if (issuesForCreate.length > 0) {
      return json(422, {
        error: {
          code: "unprocessable_entity",
          message: "The account details were not accepted",
          requestId: "r1",
          issues: issuesForCreate,
        },
      });
    }
    const body = JSON.parse(requests.at(-1)?.body ?? "{}") as {
      username: string;
      displayName: string;
      email: string;
      roleKeys: string[];
      phone?: string;
      nationalId?: string;
      homeAddress?: string;
    };
    const created: StaffAccount = {
      id: "u-new",
      username: body.username,
      displayName: body.displayName,
      email: body.email,
      phone: body.phone ?? null,
      nationalId: body.nationalId ?? null,
      homeAddress: body.homeAddress ?? null,
      status: "active",
      roles: body.roleKeys,
      mustChangeCredentials: true,
    };
    accounts = [...accounts, created];
    return json(201, { user: created });
  }
  const passwordMatch = /^\/v1\/users\/(.+)\/password$/.exec(url.pathname);
  if (request.method === "POST" && passwordMatch !== null) {
    const id = passwordMatch[1];
    const updated = accounts.map((account) =>
      account.id === id ? { ...account, mustChangeCredentials: true } : account,
    );
    accounts = updated;
    return json(200, { user: updated.find((account) => account.id === id) });
  }
  const patchMatch = /^\/v1\/users\/(.+)$/.exec(url.pathname);
  if (request.method === "PATCH" && patchMatch !== null) {
    const id = patchMatch[1];
    const body = JSON.parse(requests.at(-1)?.body ?? "{}") as Partial<StaffAccount>;
    const before = accounts.find((account) => account.id === id);
    const updated = { ...(before as StaffAccount), ...body };
    accounts = accounts.map((account) => (account.id === id ? updated : account));
    return json(200, { user: updated });
  }
  return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MANAGER = ["user:read", "user:manage", "role:read"];
const READER = ["user:read", "role:read"];
const CURRENT_USER = "u-self";

function renderPage(permissions: readonly string[] = MANAGER): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: CURRENT_USER,
      tenantId: "t1",
      displayName: "Ada",
      roles: ["system_admin"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <UsersPage />
    </QueryClientProvider>,
  );
}

function bodyOf(method: string, path: string): Record<string, unknown> | undefined {
  const found = requests.filter((row) => row.method === method && row.path === path).at(-1);
  return found === undefined ? undefined : (JSON.parse(found.body) as Record<string, unknown>);
}

/** Fills the create form and submits it, with one role checked. */
function createAccount(input: { username: string; password: string; role: string }): void {
  fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: input.username } });
  fireEvent.input(screen.getByLabelText(/^Full name/), { target: { value: "New Officer" } });
  fireEvent.input(screen.getByLabelText(/^Email/), { target: { value: "new@example.com" } });
  fireEvent.input(screen.getByLabelText(/^Temporary password/), {
    target: { value: input.password },
  });
  fireEvent.click(screen.getByLabelText(input.role));
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  useSession.setState({ status: "unknown", accessToken: undefined, user: undefined });
  fakeFetch.mockClear();
  requests.length = 0;
  accounts = [];
  issuesForCreate = [];
  vi.unstubAllEnvs();
});

describe("account helpers", () => {
  it("toggles a role without mutating the list", () => {
    const initial: readonly string[] = ["officer"];
    expect(toggleRole(initial, "finance_admin")).toEqual(["officer", "finance_admin"]);
    expect(toggleRole(initial, "officer")).toEqual([]);
    expect(initial).toEqual(["officer"]);
  });

  it("renders role names, falling back to the key for an unknown role", () => {
    expect(roleNames(roles, ["officer", "finance_admin"])).toBe("Field Officer, Finance Admin");
    expect(roleNames(roles, [])).toBe("No role");
    expect(roleNames(roles, ["mystery"])).toBe("mystery");
  });
});

describe("UsersPage", () => {
  it("lists accounts with role names and status", async () => {
    accounts = [
      {
        id: "u1",
        username: "ada.admin",
        displayName: "Ada",
        email: "ada@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "active",
        roles: ["finance_admin"],
        mustChangeCredentials: false,
      },
      {
        id: "u2",
        username: "sam.staff",
        displayName: "Sam",
        email: "sam@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "disabled",
        roles: ["officer"],
        mustChangeCredentials: true,
      },
    ];
    renderPage();

    expect(await screen.findByText("ada.admin")).toBeTruthy();
    // Scope to the list: the create form also renders a checkbox per role name.
    const list = screen.getByRole("list");
    expect(within(list).getByText("Finance Admin")).toBeTruthy();
    expect(within(list).getByText("Field Officer")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(within(list).getByText("Temporary password")).toBeTruthy();
  });

  it("creates an account with the exact body the API validates", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: "new.officer" } });
    fireEvent.input(screen.getByLabelText(/^Full name/), {
      target: { value: "New Officer" },
    });
    fireEvent.input(screen.getByLabelText(/^Email/), { target: { value: "new@example.com" } });
    fireEvent.input(screen.getByLabelText(/^Temporary password/), {
      target: { value: "temp-pass-1" },
    });
    fireEvent.click(screen.getByLabelText("Field Officer"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("new.officer")).toBeTruthy();
    expect(bodyOf("POST", "/v1/users")).toEqual({
      username: "new.officer",
      displayName: "New Officer",
      email: "new@example.com",
      password: "temp-pass-1",
      roleKeys: ["officer"],
    });
  });

  it("maps server issues back to the form fields", async () => {
    issuesForCreate = [{ path: "username", message: "That username is taken" }];
    renderPage();
    await screen.findByText("No accounts yet.");

    fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: "taken" } });
    fireEvent.input(screen.getByLabelText(/^Full name/), { target: { value: "Taken" } });
    fireEvent.input(screen.getByLabelText(/^Email/), { target: { value: "taken@example.com" } });
    fireEvent.input(screen.getByLabelText(/^Temporary password/), {
      target: { value: "temp-pass-1" },
    });
    fireEvent.click(screen.getByLabelText("Field Officer"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("That username is taken")).toBeTruthy();
  });

  it("disables an account and sends the new status", async () => {
    accounts = [
      {
        id: "u2",
        username: "sam.staff",
        displayName: "Sam",
        email: "sam@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "active",
        roles: ["officer"],
        mustChangeCredentials: false,
      },
    ];
    renderPage();
    await screen.findByText("sam.staff");

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeTruthy();
    });
    expect(bodyOf("PATCH", "/v1/users/u2")).toEqual({ status: "disabled" });
  });

  it("resets a password and shows it once in the handover card", async () => {
    accounts = [
      {
        id: "u2",
        username: "sam.staff",
        displayName: "Sam",
        email: "sam@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "active",
        roles: ["officer"],
        mustChangeCredentials: false,
      },
    ];
    renderPage();
    await screen.findByText("sam.staff");

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    const input = screen.getByLabelText(/New temporary password/);
    fireEvent.input(input, { target: { value: "fresh-pass-9" } });
    const row = screen.getByText("sam.staff").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Set temporary password" }));

    await waitFor(() => {
      expect(bodyOf("POST", "/v1/users/u2/password")).toEqual({ password: "fresh-pass-9" });
    });
    // Shown once, in the handover card, and gone when the card is dismissed.
    expect(await screen.findByText("fresh-pass-9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("fresh-pass-9")).toBeNull();
  });

  it("hides every editor from a read-only administrator", async () => {
    accounts = [
      {
        id: "u2",
        username: "sam.staff",
        displayName: "Sam",
        email: "sam@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "active",
        roles: ["officer"],
        mustChangeCredentials: false,
      },
    ];
    renderPage(READER);
    await screen.findByText("sam.staff");

    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  it("shows no editor on the signed-in administrator's own row", async () => {
    accounts = [
      {
        id: CURRENT_USER,
        username: "ada.admin",
        displayName: "Ada",
        email: "ada@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "active",
        roles: ["finance_admin"],
        mustChangeCredentials: false,
      },
    ];
    renderPage();
    await screen.findByText("ada.admin");

    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit roles" })).toBeNull();
  });

  it("hands over the officer app, the state and the password in one card", async () => {
    vi.stubEnv("VITE_FIELD_APP_URL", "https://field.example.test");
    renderPage();
    await screen.findByText("No accounts yet.");

    createAccount({ username: "new.officer", password: "temp-pass-1", role: "Field Officer" });

    expect(await screen.findByText("Hand over to New Officer")).toBeTruthy();
    expect(screen.getByText("https://field.example.test")).toBeTruthy();
    expect(screen.getByText("katsina-state")).toBeTruthy();
    expect(screen.getByText("temp-pass-1")).toBeTruthy();
    // An officer has no business on the dashboard, so its address is not offered.
    expect(screen.queryByText("Dashboard")).toBeNull();
  });

  it("sends a dashboard role to the dashboard address", async () => {
    vi.stubEnv("VITE_ADMIN_APP_URL", "https://admin.example.test");
    renderPage();
    await screen.findByText("No accounts yet.");

    createAccount({ username: "new.finance", password: "temp-pass-1", role: "Finance Admin" });

    expect(await screen.findByText("https://admin.example.test")).toBeTruthy();
    expect(screen.queryByText("Officer app")).toBeNull();
  });

  it("names the missing variable instead of linking nowhere", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    createAccount({ username: "new.officer", password: "temp-pass-1", role: "Field Officer" });

    expect(await screen.findByText(/not configured in this build/i)).toBeTruthy();
    expect(screen.getByText(/VITE_FIELD_APP_URL/)).toBeTruthy();
  });

  it("drops the password when the card is dismissed", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    createAccount({ username: "new.officer", password: "temp-pass-1", role: "Field Officer" });
    await screen.findByText("Hand over to New Officer");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("temp-pass-1")).toBeNull();
    expect(screen.queryByText("Hand over to New Officer")).toBeNull();
  });

  it("reopens the card for an account still holding its temporary password", async () => {
    accounts = [
      {
        id: "u2",
        username: "sam.staff",
        displayName: "Sam",
        email: "sam@example.com",
        phone: null,
        nationalId: null,
        homeAddress: null,
        status: "active",
        roles: ["officer"],
        mustChangeCredentials: true,
      },
    ];
    renderPage();
    await screen.findByText("sam.staff");

    fireEvent.click(screen.getByRole("button", { name: "Handover" }));

    expect(await screen.findByText("Hand over to Sam")).toBeTruthy();
    // The server cannot read the password back, so the card says so.
    expect(screen.getByText(/not stored in a readable form/i)).toBeTruthy();
  });

  it("generates a temporary password when asked", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    const input = screen.getByLabelText(/^Temporary password/) as HTMLInputElement;
    expect(input.value).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{16}$/);
  });

  it("calls the name field the full name", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");
    expect(screen.getByLabelText(/^Full name/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Display name/)).toBeNull();
  });

  it("asks for the collector details only when the collector role is chosen", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    expect(screen.queryByLabelText(/^Phone number/)).toBeNull();

    fireEvent.click(screen.getByLabelText("Collector"));

    expect(screen.getByLabelText(/^Phone number/)).toBeTruthy();
    expect(screen.getByLabelText(/^National ID number/)).toBeTruthy();
    expect(screen.getByLabelText(/^Home address/)).toBeTruthy();
    // The state's rule, in words, from the config the dashboard holds.
    expect(screen.getByText("11 digits")).toBeTruthy();
  });

  it("sends the collector profile with the account", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: "new.collector" } });
    fireEvent.input(screen.getByLabelText(/^Full name/), { target: { value: "Musa Collector" } });
    fireEvent.input(screen.getByLabelText(/^Email/), { target: { value: "musa@example.com" } });
    fireEvent.input(screen.getByLabelText(/^Temporary password/), {
      target: { value: "temp-pass-1" },
    });
    fireEvent.click(screen.getByLabelText("Collector"));
    fireEvent.input(screen.getByLabelText(/^Phone number/), {
      target: { value: "08012345678" },
    });
    fireEvent.input(screen.getByLabelText(/^National ID number/), {
      target: { value: "12345678901" },
    });
    fireEvent.input(screen.getByLabelText(/^Home address/), {
      target: { value: "12 Market Road" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(bodyOf("POST", "/v1/users")).toEqual({
        username: "new.collector",
        displayName: "Musa Collector",
        email: "musa@example.com",
        password: "temp-pass-1",
        roleKeys: ["collector"],
        phone: "08012345678",
        nationalId: "12345678901",
        homeAddress: "12 Market Road",
      });
    });
  });

  it("refuses a collector account without the details, without asking the server", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: "new.collector" } });
    fireEvent.input(screen.getByLabelText(/^Full name/), { target: { value: "Musa Collector" } });
    fireEvent.input(screen.getByLabelText(/^Email/), { target: { value: "musa@example.com" } });
    fireEvent.input(screen.getByLabelText(/^Temporary password/), {
      target: { value: "temp-pass-1" },
    });
    fireEvent.click(screen.getByLabelText("Collector"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Enter a phone number")).toBeTruthy();
    expect(screen.getByText("Enter the national ID number")).toBeTruthy();
    expect(screen.getByText("Enter a home address")).toBeTruthy();
    expect(requests.some((row) => row.method === "POST")).toBe(false);
  });

  it("rejects a national ID that does not match the state's rule", async () => {
    renderPage();
    await screen.findByText("No accounts yet.");

    fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: "new.collector" } });
    fireEvent.input(screen.getByLabelText(/^Full name/), { target: { value: "Musa Collector" } });
    fireEvent.input(screen.getByLabelText(/^Email/), { target: { value: "musa@example.com" } });
    fireEvent.input(screen.getByLabelText(/^Temporary password/), {
      target: { value: "temp-pass-1" },
    });
    fireEvent.click(screen.getByLabelText("Collector"));
    fireEvent.input(screen.getByLabelText(/^Phone number/), {
      target: { value: "08012345678" },
    });
    fireEvent.input(screen.getByLabelText(/^National ID number/), { target: { value: "12345" } });
    fireEvent.input(screen.getByLabelText(/^Home address/), {
      target: { value: "12 Market Road" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("Enter the national ID in the format this state uses"),
    ).toBeTruthy();
    expect(requests.some((row) => row.method === "POST")).toBe(false);
  });

  it("lists the collector's contact and identity details", async () => {
    accounts = [
      {
        id: "u3",
        username: "musa.collector",
        displayName: "Musa Collector",
        email: "musa@example.com",
        phone: "08012345678",
        nationalId: "12345678901",
        homeAddress: "12 Market Road",
        status: "active",
        roles: ["collector"],
        mustChangeCredentials: false,
      },
    ];
    renderPage();
    await screen.findByText("musa.collector");

    expect(screen.getByText("Phone 08012345678")).toBeTruthy();
    expect(screen.getByText("National ID 12345678901")).toBeTruthy();
    expect(screen.getByText("Home address 12 Market Road")).toBeTruthy();
  });
});
