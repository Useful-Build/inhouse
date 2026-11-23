// A routine's on/off switch, on its row and in its details. The agent's global pause doesn't move it: the switch shows
// the routine's own setting, and the pause shows apart in plain words ("Paused" for the next run).

/** What the switch shows (`on`) and what a click saves (`turnsTo`), whether or not the agent is paused. */
export const routineSwitch = (it: { on: boolean }, _paused: boolean): { on: boolean; turnsTo: boolean } => ({ on: it.on, turnsTo: !it.on })
