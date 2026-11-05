import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AuthenticatedImage } from "./AuthenticatedImage.js";

/**
 * `apps/admin`'s vitest config has no `globals: true`, so Testing Library never
 * registers its own cleanup and renders pile up between tests.
 */
afterEach(() => {
  cleanup();
});

describe("AuthenticatedImage", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:photo");
    URL.revokeObjectURL = vi.fn();
  });

  it("fetches the image with the session instead of pointing an <img> at the API", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(new Blob(["jpeg"], { type: "image/jpeg" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<AuthenticatedImage src="/v1/assets/a-1/photos/p-1" alt="Asset photo 1" />);

    const image = await screen.findByAltText("Asset photo 1");
    expect(image.getAttribute("src")).toBe("blob:photo");
    // A bare <img src="/v1/…"> carries no Authorization header and gets a 401.
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/assets\/a-1\/photos\/p-1$/),
      expect.objectContaining({ headers: expect.anything() as unknown }),
    );
    vi.unstubAllGlobals();
  });

  it("says a photo is unavailable instead of showing a broken image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    render(<AuthenticatedImage src="/v1/assets/a-1/photos/p-1" alt="Asset photo 1" />);

    expect(await screen.findByText(/photo unavailable/i)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("releases the object URL when it unmounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["jpeg"]), { status: 200 })),
    );

    const { unmount } = render(<AuthenticatedImage src="/v1/a" alt="Photo" />);
    await screen.findByAltText("Photo");
    unmount();

    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });
    vi.unstubAllGlobals();
  });
});
