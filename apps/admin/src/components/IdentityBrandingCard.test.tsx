import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { useToasts } from "../toast.js";
import { IdentityBrandingCard, fieldIssues } from "./IdentityBrandingCard.js";

/**
 * The system admin's identity card. The API owns the rules; this screen has to
 * prefill from the stored config, send the fields it edits, and put a server
 * 422 back on the field it names.
 */

const requests: { method: string; path: string; body: string }[] = [];
let respond: (body: unknown) => Response = () =>
  new Response(JSON.stringify({ config: {}, version: 2 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fakeFetch = vi.fn(async (input: unknown) => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  const body = await request.clone().text();
  requests.push({ method: request.method, path: url.pathname, body });
  return respond(body === "" ? undefined : JSON.parse(body));
});

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  fakeFetch.mockClear();
  requests.length = 0;
  useToasts.setState({ toasts: [] });
  respond = () =>
    new Response(JSON.stringify({ config: {}, version: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
});

function renderCard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <IdentityBrandingCard config={loadFixtureConfig()} />
    </QueryClientProvider>,
  );
}

/** `exact: false` because a label with a hint reads "Legal entity Printed on…". */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
}

describe("IdentityBrandingCard", () => {
  it("prefills from the stored configuration", () => {
    renderCard();
    expect(input("App name").value).toBe("Example Levy");
    expect(input("Legal entity").value).toBe("Example State Revenue Authority");
    expect(input("Support email").value).toBe("support@example.state.gov");
    expect(input("Support phone").value).toBe("+2348000000000");
    expect(input("Primary colour hex").value).toBe("#0a5");
  });

  it("saves the edited fields through the identity endpoint", async () => {
    renderCard();
    fireEvent.input(input("App name"), { target: { value: "Katsina Levy" } });
    fireEvent.input(input("Support phone"), { target: { value: "+234 800 111 2222" } });
    fireEvent.click(screen.getByRole("button", { name: "Save state details" }));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.path).toBe("/v1/tenants/current/identity");
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      appName: string;
      supportPhone: string;
      colors: { primary: string };
    };
    expect(body.appName).toBe("Katsina Levy");
    expect(body.supportPhone).toBe("+234 800 111 2222");
    // Colours travel together, because the config stores them as one object.
    expect(body.colors.primary).toBe("#0a5");

    await waitFor(() => {
      expect(useToasts.getState().toasts[0]?.message).toBe("State details saved.");
    });
  });

  it("puts a server 422 back on the field it names", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "unprocessable_entity",
            message: "Invalid tenant configuration",
            requestId: "r1",
            issues: [
              {
                path: "identity.supportContacts.email",
                message: "identity.supportContacts.email must be an email address",
              },
            ],
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    renderCard();
    fireEvent.input(input("Support email"), { target: { value: "not-an-address" } });
    fireEvent.click(screen.getByRole("button", { name: "Save state details" }));

    await waitFor(() => {
      expect(screen.getByText(/must be an email address/)).toBeDefined();
    });
    // A field error is enough: no success toast, and no generic failure toast.
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("removes the logo back to the state's initials", () => {
    renderCard();
    expect(screen.getByTestId("branding-logo")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByTestId("branding-initials").textContent).toBe("EL");
  });
});

describe("fieldIssues", () => {
  it("maps config paths onto the card's fields and ignores anything else", () => {
    const mapped = fieldIssues({
      error: {
        issues: [
          { path: "branding.logoUrl", message: "too big" },
          { path: "branding.colors.accent", message: "not hex" },
          { path: "obligations.feeRules", message: "not on this screen" },
        ],
      },
    });
    expect(mapped).toEqual({ logoUrl: "too big", colors: "not hex" });
  });

  it("returns nothing for an error without issues", () => {
    expect(fieldIssues({ error: { code: "conflict" } })).toEqual({});
    expect(fieldIssues(undefined)).toEqual({});
  });
});
