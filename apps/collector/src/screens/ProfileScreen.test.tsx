import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProfileScreen } from "./ProfileScreen.js";
import { testConfig } from "../test-support/tenant.js";

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));

const install = vi.hoisted(() => ({
  kind: "prompt" as "installed" | "prompt" | "ios" | "unsupported",
  promptInstall: vi.fn(),
}));

const state = {
  user: {
    userId: "u-1",
    tenantId: "t-1",
    displayName: "Musa Abdullahi",
    username: "alpha.collector",
    phone: "+2348000000001",
    nationalId: "12345678901",
    homeAddress: "12 Market Road",
    roles: ["collector"],
    permissions: ["cash:manage"],
    mustChangeCredentials: false,
  } as {
    userId: string;
    tenantId: string;
    displayName: string;
    username: string;
    phone: string | null;
    nationalId: string | null;
    homeAddress: string | null;
    roles: string[];
    permissions: string[];
    mustChangeCredentials: boolean;
  },
};

vi.mock("../session.js", () => ({
  useSession: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => ({ logout }),
  }),
}));

vi.mock("../lib/data.js", () => ({
  useTenantConfig: () => testConfig(),
  useWallet: () => ({
    data: {
      wallet: {
        balanceMinor: "125000",
        floatCeilingMinor: "5000000",
        status: "active",
        frozenReason: null,
        openIntakeTotalMinor: "0",
        oldestOpenIntakeAt: null,
        depositInstruction: null,
      },
      intakes: [],
    },
    error: undefined,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("../lib/install.js", () => ({
  useInstallKind: () => install.kind,
  promptInstall: install.promptInstall,
}));

const noop = (): void => undefined;

describe("collector profile", () => {
  beforeEach(() => {
    logout.mockReset();
    install.promptInstall.mockReset();
    install.kind = "prompt";
    state.user = {
      userId: "u-1",
      tenantId: "t-1",
      displayName: "Musa Abdullahi",
      username: "alpha.collector",
      phone: "+2348000000001",
      nationalId: "12345678901",
      homeAddress: "12 Market Road",
      roles: ["collector"],
      permissions: ["cash:manage"],
      mustChangeCredentials: false,
    };
  });

  it("shows the collector who they are signed in as", () => {
    render(<ProfileScreen onBack={noop} />);

    expect(screen.getByRole("heading", { name: "Profile" })).toBeTruthy();
    expect(screen.getByText("Musa Abdullahi")).toBeTruthy();
    expect(screen.getByText("alpha.collector")).toBeTruthy();
    expect(screen.getByText("+2348000000001")).toBeTruthy();
    expect(screen.getByText("12 Market Road")).toBeTruthy();
    expect(screen.getByText("Alpha State")).toBeTruthy();
    expect(screen.getByText("Collector")).toBeTruthy();
  });

  it("masks the national ID until the collector asks to see it", () => {
    render(<ProfileScreen onBack={noop} />);

    expect(screen.getByText("•••••••8901")).toBeTruthy();
    expect(screen.queryByText("12345678901")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show national ID" }));
    expect(screen.getByText("12345678901")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide national ID" }));
    expect(screen.getByText("•••••••8901")).toBeTruthy();
  });

  it("says a field is not recorded rather than leaving it blank", () => {
    state.user = { ...state.user, phone: null, nationalId: null, homeAddress: null };
    render(<ProfileScreen onBack={noop} />);

    expect(screen.getAllByText("Not recorded")).toHaveLength(3);
    // Nothing to reveal, so no control that would do nothing.
    expect(screen.queryByRole("button", { name: /national ID/ })).toBeNull();
  });

  it("installs the app when the browser has offered a prompt", () => {
    render(<ProfileScreen onBack={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Install on this phone" }));

    expect(install.promptInstall).toHaveBeenCalledTimes(1);
  });

  it("explains the Share menu where the browser has no install prompt", () => {
    install.kind = "ios";
    render(<ProfileScreen onBack={noop} />);

    expect(screen.getByText(/tap Share/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install on this phone" })).toBeNull();
  });

  it("does not offer to install an app that is already installed", () => {
    install.kind = "installed";
    render(<ProfileScreen onBack={noop} />);

    expect(screen.getByText(/Installed on this phone/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install on this phone" })).toBeNull();
  });

  it("signs out from the profile, where the action belongs", () => {
    render(<ProfileScreen onBack={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
