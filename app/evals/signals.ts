// The signals that cancel an eval run, with their exit codes, for every runner (#711, #719): a Ctrl-C (SIGINT), a hangup
// (SIGHUP: a closed terminal or a dropped SSH session, whose default would end the run with no give-back, its lease, shop
// override or Slack left behind) and a job's stop (SIGTERM).
export const CANCEL_SIGNALS = [['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]] as const
