// The one list of headers a key may never take and a request to a connection may never carry (Stage 1 M4-R1, N42; #731).
// index/schemas.ts holds it (that file imports only zod, and the product reads it): prepare refuses a key place naming
// one, oauth/http.ts `validCredential` refuses one at the send, and the senders (call.ts, send.ts) refuse a request that
// carries a never-sent header. Nothing is stripped silently.
export { firstNeverSent, forbiddenKeyHeader, NEVER_SENT_HEADERS, neverSentHeader, TRANSPORT_HEADERS } from '../index/schemas'
