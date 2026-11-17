import { convexAuth } from "@convex-dev/auth/server"
import { ResendOTP } from "./ResendOTP"

const DAY = 24 * 60 * 60 * 1000

// Stay signed in for a year after the last visit, three years at most.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [ResendOTP],
  session: { inactiveDurationMs: 365 * DAY, totalDurationMs: 3 * 365 * DAY },
})
