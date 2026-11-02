import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { useSession } from "../session.js";
import { CredentialForm } from "./CredentialForm.js";

/**
 * The last onboarding step: replace the provisioning account's credentials.
 * The client-side rules mirror the server's (`credentialIssues`), and a
 * successful completion installs the new session and lands on the first page
 * the role may open.
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const meBody = {
  userId: "u1",
  tenantId: "t1",
  displayName: "Aisha Bello",
  roles: ["system_admin"],
  permissions: ["asset:read"],
  mustChangeCredentials: false,
};

function reset(): void {
  useSession.setState({
    status: "anonymous",
    accessToken: undefined,
    user: undefined,
    needsSetup: false,
  });
  window.location.hash = "";
}

beforeAll(() => {
  stubRelativeRequests();
});

afterEach(() => {
  cleanup();
  reset();
  vi.unstubAllGlobals();
});

function submit(username: string, password: string): void {
  fireEvent.input(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.input(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
}

describe("CredentialForm", () => {
  it("renders the username and password fields", () => {
    render(<CredentialForm />);
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByText("Choose your credentials")).toBeTruthy();
  });

  it("refuses the provisioning username", () => {
    render(<CredentialForm />);
    submit("admin", "levy-2026");
    expect(
      screen.getByText(/"admin" is the provisioning account; choose your own username/),
    ).toBeTruthy();
  });

  it("refuses the provisioning password", () => {
    render(<CredentialForm />);
    submit("aisha.bello", "password");
    expect(
      screen.getByText(/"password" is the temporary password; choose your own/),
    ).toBeTruthy();
  });

  it("blocks a five-character password", () => {
    render(<CredentialForm />);
    submit("aisha.bello", "levy");
    expect(screen.getByText("Use at least 6 characters")).toBeTruthy();
  });

  it("refuses a password equal to the username", () => {
    render(<CredentialForm />);
    submit("aisha.bello", "Aisha.Bello");
    expect(screen.getByText("The password must not be the username")).toBeTruthy();
  });

  it("completes onboarding and lands on the first permitted page", async () => {
    let completionBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request =
          typeof input === "object" && input !== null && "url" in input
            ? (input as Request)
            : new Request(String(input), init);
        const url = new URL(request.url, "http://localhost").pathname;
        if (url === "/v1/auth/complete-onboarding" && request.method === "POST") {
          completionBody = (await request.json()) as Record<string, unknown>;
          return json(200, {
            token: "tok-complete",
            expiresAt: "2026-10-23T13:00:00.000Z",
            user: { userId: "u1", tenantId: "t1", displayName: "Aisha Bello", roles: ["system_admin"], mustChangeCredentials: false },
            refreshToken: "r-complete",
            refreshExpiresAt: "2026-10-24T13:00:00.000Z",
          });
        }
        if (url === "/v1/auth/me") return json(200, meBody);
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r" } });
      }),
    );

    render(<CredentialForm />);
    submit("aisha.bello", "levy-2026");

    await waitFor(() => {
      expect(useSession.getState().status).toBe("authenticated");
      expect(useSession.getState().user?.mustChangeCredentials).toBe(false);
    });
    expect(completionBody).toEqual({ username: "aisha.bello", password: "levy-2026" });
    // firstPermittedRoute(["asset:read"]) is /registry.
    expect(window.location.hash).toBe("#/registry");
  });
});
