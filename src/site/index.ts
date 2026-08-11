import './site.css'
import { installFooter } from './footer'
import { installPrivacyPanel } from './privacy'
import { runWelcome, type SiteDeps } from './welcome'

export type { SiteDeps }

/**
 * Installs the site chrome: welcome gate, privacy panel, footer. Resolves once the
 * viewer has entered — either by completing the full gate or, on a return visit, by
 * granting the camera through the compact resume prompt.
 */
export async function installSite(deps: SiteDeps): Promise<void> {
  const root = document.getElementById('site')
  if (!root) throw new Error('#site root not found')

  const privacy = installPrivacyPanel(root)
  installFooter(root, { onOpenPrivacy: privacy.open })

  await runWelcome(root, deps, privacy)
}
