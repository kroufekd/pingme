import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";

// pingme runs on its own Convex project, so the host's VITE_CONVEX_URL is ignored on purpose.
// VITE_PINGME_CONVEX_URL points a local build or a self-hosted copy at another deployment.
const CONVEX_URL = (import.meta as any).env.VITE_PINGME_CONVEX_URL || 'https://amiable-magpie-936.convex.cloud'
const convex = new ConvexReactClient(CONVEX_URL)

export default function AppConvexProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ConvexAuthProvider client={convex}>
      {children}
    </ConvexAuthProvider>
  )
}
