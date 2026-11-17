import { createFileRoute } from '@tanstack/react-router'
import { App } from '../components/app/app'
import { canonicalUrl } from '../lib/canonical-url'
import siteMetadata from '../metadata.json'

const homepageMeta = siteMetadata['/']

export const Route = createFileRoute('/')({
  head: () => {
    const canonical = canonicalUrl('/')

    return {
      meta: [
        { title: homepageMeta.title },
        { name: 'description', content: homepageMeta.description },
      ],
      links: canonical ? [{ rel: 'canonical', href: canonical }] : [],
    }
  },
  component: App,
})
