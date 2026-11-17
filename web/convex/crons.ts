import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Every run is a billed backend call: hourly is enough, the Mac drops the list itself on its next sync.

crons.interval("drop shared list when nobody watches", { hours: 1 }, internal.mac.dropStaleSnapshot, {})
crons.interval("delete expired statuses, invite links and old commands", { hours: 1 }, internal.cleanup.run, {})
crons.interval("delete expired messages, pairing requests and rate limits", { hours: 1 }, internal.cleanup.network, {})

export default crons
