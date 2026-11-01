import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RegisterScreen } from "./RegisterScreen.js";
import { api } from "../api/client.js";
import { testConfig } from "../test-support/tenant.js";

vi.mock("../api/client.js", () => ({
  api: { POST: vi.fn() },
}));

vi.mock("../lib/data.js", () => ({
  useTenantConfig: () => testConfig(),
}));

const noop = (): void => undefined;

/**
 * The shape openapi-fetch returns: `data` for a 2xx, `error` for anything else.
 * Reading `data` on a refusal is the bug this file exists to prevent.
 */
function response(
  status: number,
  body: unknown,
): {
  readonly response: Response;
  readonly data?: unknown;
  readonly error?: unknown;
} {
  const result = { response: new Response(null, { status }) };
  return status >= 200 && status < 300 ? { ...result, data: body } : { ...result, error: body };
}

function fillForm(): void {
  fireEvent.change(screen.getByLabelText(/plate number/i), { target: { value: "ABC 123" } });
  fireEvent.change(screen.getByLabelText(/owner name/i), { target: { value: "Owner One" } });
  fireEvent.change(screen.getByLabelText(/owner phone/i), { target: { value: "+2348000000001" } });
  fireEvent.click(screen.getByRole("button", { name: /register vehicle/i }));
}

describe("RegisterScreen", () => {
  beforeEach(() => {
    vi.mocked(api.POST).mockReset();
  });

  it("shows the server's per-attribute reason, by label, when it refuses", async () => {
    vi.mocked(api.POST).mockResolvedValue(
      response(422, {
        error: {
          code: "unprocessable_entity",
          message: "Asset attributes are invalid",
          issues: [{ path: "plate_number", message: "Must match pattern ^[A-Z0-9]{5,8}$" }],
        },
      }),
    );

    render(<RegisterScreen onBack={noop} />);
    fillForm();

    expect(await screen.findByText(/plate number: must match pattern/i)).toBeTruthy();
  });

  it("does not fall back to a generic sentence when the server explains itself", async () => {
    vi.mocked(api.POST).mockResolvedValue(
      response(422, { error: { code: "unprocessable_entity", message: "Owner phone is invalid" } }),
    );

    render(<RegisterScreen onBack={noop} />);
    fillForm();

    expect(await screen.findByText(/owner phone is invalid/i)).toBeTruthy();
    expect(screen.queryByText(/the server refused the registration/i)).toBeNull();
  });

  it("keeps a fallback for a refusal with no explanation at all", async () => {
    vi.mocked(api.POST).mockResolvedValue(response(403, {}));

    render(<RegisterScreen onBack={noop} />);
    fillForm();

    expect(await screen.findByText(/the server refused the registration/i)).toBeTruthy();
  });

  it("shows the short code the driver will quote once the vehicle exists", async () => {
    vi.mocked(api.POST).mockResolvedValue(
      response(200, {
        asset: { id: "a-1", shortCode: "B001000", assetTypeKey: "bike" },
      }),
    );

    render(<RegisterScreen onBack={noop} />);
    fillForm();

    expect(await screen.findByText("B001000")).toBeTruthy();
  });

  it("tells the officer to try again when the phone is offline", async () => {
    vi.mocked(api.POST).mockRejectedValue(new TypeError("Failed to fetch"));

    render(<RegisterScreen onBack={noop} />);
    fillForm();

    expect(await screen.findByText(/no connection/i)).toBeTruthy();
  });
});
