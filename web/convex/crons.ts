import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval("drop shared list when nobody watches", { minutes: 15 }, internal.mac.dropStaleSnapshot, {})
crons.interval("delete expired statuses, invite links and old commands", { hours: 1 }, internal.cleanup.run, {})
crons.interval("delete expired messages, pairing requests and rate limits", { minutes: 10 }, internal.cleanup.network, {})

export default crons
