-- The service rows (p2-design section 1), with fixed ids: `system` is the actor of lines nobody caused (a grant's
-- expiry, the first Admin's invite); `smoke` is the smoke check's Member-level principal. `monitor` has no row.
INSERT INTO members (id, kind, role, status, name, service_name, created_at_ms)
VALUES ('m_system', 'service', NULL, 'active', 'Inhouse system', 'system', 0);
INSERT INTO members (id, kind, role, status, name, service_name, created_at_ms)
VALUES ('m_smoke', 'service', 'member', 'active', 'Smoke check', 'smoke', 0);
