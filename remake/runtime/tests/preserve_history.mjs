// Compatibility preload for historical commands. Tests no longer write reports.
// Intentionally leaves Node's filesystem APIs unchanged; current summaries are
// emitted by tools/verify_tests.py into a fresh run directory only on request.
export {};
