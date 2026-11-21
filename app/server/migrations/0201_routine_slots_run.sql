-- P4 W2 PR 2 (#262 review, L4): route 33 looks a routine run up by its run id (`routines/store.ts` isRoutineRun:
-- `run_id = ? OR turn_id = ?`). turn_id has its unique index (0200); this gives run_id one.
CREATE INDEX routine_slots_run ON routine_slots(run_id) WHERE run_id IS NOT NULL;
