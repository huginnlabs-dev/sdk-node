/**
 * The pristine global fetch, captured once at module load — before any
 * dataflow.instrumentHttp() call can wrap globalThis.fetch. The delivery
 * pipeline and manifest reporting send through this reference so SDK-owned
 * POSTs are never instrumented as HTTP_CLIENT spans of themselves (which
 * would both pollute traces and recurse).
 */
export const rawFetch: typeof fetch = globalThis.fetch;
