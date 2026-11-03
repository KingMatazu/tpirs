/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set only when the dashboard is served from a different origin than the API. */
  readonly VITE_API_BASE_URL?: string;
  /**
   * The dashboard's own public address, for the account handover card. Unset
   * means "wherever this dashboard is being served", which is always right.
   */
  readonly VITE_ADMIN_APP_URL?: string;
  /** The officer app's public address. Unset renders "not configured" on the card. */
  readonly VITE_FIELD_APP_URL?: string;
  /** The collector app's public address. Unset renders "not configured" on the card. */
  readonly VITE_COLLECTOR_APP_URL?: string;
}
