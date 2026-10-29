import { create } from "zustand";

/**
 * The dashboard language the user picked. It is a view preference, not tenant
 * data: the tenant decides which languages exist, and the shell falls back to
 * the tenant default when the pick is not enabled (or after signing into a
 * different tenant).
 */
interface UiLanguageState {
  readonly language: string | undefined;
  setLanguage(language: string | undefined): void;
}

export const useUiLanguage = create<UiLanguageState>()((set) => ({
  language: undefined,
  setLanguage(language) {
    set({ language });
  },
}));
