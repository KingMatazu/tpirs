import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BrandingLogo, initialsFor, logoSource } from "./BrandingLogo.js";
import { PoweredBy } from "./PoweredBy.js";

afterEach(() => {
  cleanup();
});

describe("logoSource", () => {
  it("accepts an upload and a hosted https URL", () => {
    expect(logoSource("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
    expect(logoSource("https://cdn.example.gov/logo.svg")).toBe("https://cdn.example.gov/logo.svg");
  });

  it("treats the old relative placeholder and empty values as no logo", () => {
    expect(logoSource("")).toBeUndefined();
    expect(logoSource(undefined)).toBeUndefined();
    expect(logoSource("logo.svg")).toBeUndefined();
  });
});

describe("initialsFor", () => {
  it("uses the first and last word", () => {
    expect(initialsFor("Katsina State")).toBe("KS");
    expect(initialsFor("Katsina")).toBe("K");
    expect(initialsFor("  ")).toBe("?");
  });
});

describe("BrandingLogo", () => {
  it("renders the uploaded image when there is one", () => {
    render(
      <BrandingLogo logoUrl="data:image/png;base64,AAA" name="Katsina State" className="h-7 w-7" />,
    );
    const image = screen.getByTestId("branding-logo");
    expect(image.getAttribute("alt")).toBe("Katsina State");
  });

  it("falls back to the state's initials rather than a broken image", () => {
    render(<BrandingLogo logoUrl="" name="Katsina State" className="h-7 w-7" />);
    expect(screen.getByTestId("branding-initials").textContent).toBe("KS");
    expect(screen.queryByTestId("branding-logo")).toBeNull();
  });
});

describe("PoweredBy", () => {
  it("names the firm, as plain text while there is no website to link to", () => {
    render(<PoweredBy />);
    const footer = screen.getByTestId("powered-by");
    expect(footer.textContent).toBe("Powered by Star Galaxy Innovation and Technology Ltd");
    // No href yet, so no anchor: a link to nowhere would just reload the page.
    expect(footer.querySelector("a")).toBeNull();
  });
});
