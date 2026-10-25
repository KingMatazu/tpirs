import { describe, expect, it } from "vitest";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { catalogMatrix, flattenMenus } from "./channelsView.js";

const config = loadFixtureConfig();

describe("flattenMenus", () => {
  it("walks breadth-first from the start menu", () => {
    const order = flattenMenus(config).map((menu) => menu.key);
    // main → account (option 1) → complete (account's next). The detached
    // action node appears last so a config typo is visible rather than hidden.
    expect(order).toEqual(["main", "account", "complete", "orphan"]);
  });

  it("exposes option targets and input constraints as data", () => {
    const account = flattenMenus(config).find((menu) => menu.key === "account");
    expect(account).toMatchObject({
      type: "input",
      promptKey: "ussd.account.prompt",
      inputKey: "assetRef",
      inputPattern: "^[A-Z0-9]{6,8}$",
      inputErrorKey: "ussd.account.error",
      options: [],
    });
    const main = flattenMenus(config).find((menu) => menu.key === "main");
    expect(main?.options[0]).toMatchObject({ key: "1", next: "account", action: null });
    expect(main?.options[1]).toMatchObject({ key: "9", action: "status", next: null });
  });
});

describe("catalogMatrix", () => {
  it("builds one column per configured language and flags missing rows", () => {
    const matrix = catalogMatrix(config);
    expect(matrix.languages).toEqual(["en", "ha"]);
    const promptRow = matrix.rows.find((row) => row.key === "ussd.main.prompt");
    expect(promptRow?.cells).toEqual([
      { language: "en", value: "Example Levy. Reply with an option." },
      { language: "ha", value: "Kuɗin Jiha. Amsa da zaɓi." },
    ]);
  });
});
