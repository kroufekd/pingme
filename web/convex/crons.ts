import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval("drop shared list when nobody watches", { minutes: 15 }, internal.mac.dropStaleSnapshot, {})
crons.interval("delete expired statuses, invite links and old commands", { hours: 1 }, internal.cleanup.run, {})

export default crons
