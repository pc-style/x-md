# Agent notes

## Maintenance notice popup

A temporary work-in-progress banner shows on page load for the homepage and dashboard.

- Module: `src/maintenance-notice.ts`
- Wired in: `src/main.ts`, `src/dashboard.ts`
- Styles: `src/style.css` (`.maintenance-*` classes)

When the in-progress work is moved to production and the site is stable again, **ask the user whether they want the maintenance notice removed** before deleting it.

To remove it after confirmation:

1. Delete `src/maintenance-notice.ts`
2. Remove `setupMaintenanceNotice()` imports and calls from `src/main.ts` and `src/dashboard.ts`
3. Remove the `.maintenance-*` styles from `src/style.css`
