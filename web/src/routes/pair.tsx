import { createFileRoute } from '@tanstack/react-router'
import { App } from '../components/app/app'

// The Mac app opens /pair#<pairId>.<secret>. The fragment stays in the browser.
export const Route = createFileRoute('/pair')({
  head: () => ({
    meta: [{ title: 'Připojit Mac · pingme' }, { name: 'robots', content: 'noindex' }],
  }),
  component: PairPage,
})

function PairPage() {
  return <App view="pair" />
}
