# @tpirs/field

Officer field app (PWA) for Phase 6. Offline store uses IndexedDB (`idb`), the offline resolver enforces "never unpaid" (only `paid` or `not_in_offline_list`), and scans/disputes queue in an outbox for sync.
