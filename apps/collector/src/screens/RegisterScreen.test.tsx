import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RegisterScreen } from "./RegisterScreen.js";
import { api } from "../api/client.js";
import { testConfig } from "../test-support/tenant.js";

vi.mock("../api/client.js", () => ({
  api: { POST: vi.fn(), GET: vi.fn() },
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
    vi.mocked(api.GET).mockReset();
    // jsdom has no object URLs; the panel only needs one that round-trips.
    URL.createObjectURL = vi.fn(() => "blob:sticker");
    URL.revokeObjectURL = vi.fn();
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

describe("the sticker", () => {
  beforeEach(() => {
    vi.mocked(api.POST).mockReset();
    vi.mocked(api.GET).mockReset();
    URL.createObjectURL = vi.fn(() => "blob:sticker");
    URL.revokeObjectURL = vi.fn();
  });

  async function register(): Promise<void> {
    vi.mocked(api.POST).mockResolvedValue(
      response(200, { asset: { id: "a-1", shortCode: "B001000", assetTypeKey: "bike" } }),
    );
    render(<RegisterScreen onBack={noop} />);
    fillForm();
    await screen.findByText("B001000");
  }

  it("fetches the sticker with the session instead of linking to it", async () => {
    vi.mocked(api.GET).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      data: "<svg/>",
    });
    await register();

    fireEvent.click(screen.getByRole("button", { name: /show the sticker/i }));

    // A plain link would open a new tab with no Authorization header and get a
    // 401; the app has to fetch it itself.
    expect(await screen.findByAltText(/sticker for B001000/i)).toBeTruthy();
    expect(vi.mocked(api.GET)).toHaveBeenCalledWith("/v1/assets/{id}/sticker", {
      params: { path: { id: "a-1" } },
    });
  });

  it("offers to save the sticker once it is loaded", async () => {
    vi.mocked(api.GET).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      data: "<svg/>",
    });
    await register();
    fireEvent.click(screen.getByRole("button", { name: /show the sticker/i }));

    const save = await screen.findByText(/save the sticker/i);
    expect(save.getAttribute("download")).toBe("sticker-B001000.svg");
  });

  it("says so when the sticker cannot be loaded", async () => {
    vi.mocked(api.GET).mockResolvedValue({
      response: new Response(null, { status: 401 }),
      error: { error: { code: "unauthorized" } },
    });
    await register();
    fireEvent.click(screen.getByRole("button", { name: /show the sticker/i }));

    expect(await screen.findByText(/sticker could not be loaded/i)).toBeTruthy();
  });
});
