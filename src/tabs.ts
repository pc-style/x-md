import { GREEN } from './gradients-pro/green'
import { glowTabs } from './gradients-pro/glow-tabs'

/**
 * Turns the stacked "what comes through" panels into tabs (the WAI-ARIA tabs
 * pattern with automatic activation: arrows, Home and End move and select).
 *
 * The markup ships every panel stacked and the tablist `hidden`, so the section
 * reads top to bottom with JavaScript off. Here the tablist is shown and the
 * panels become `role="tabpanel"`; `data-tabs-ready` stacks them in one grid
 * cell (style.css) so switching is a crossfade and never changes the height.
 * Inactive panels are `visibility: hidden`, which also takes them out of the
 * tab order and the accessibility tree. The selected tab is lit from its
 * underline by gradients.sh's Glow Tabs light, which slides between tabs.
 */
export function setupTabs(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-tabs]').forEach((tabs) => {
    const list = tabs.querySelector<HTMLElement>('[role="tablist"]')
    const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panels = buttons.map((button) => document.getElementById(button.getAttribute('aria-controls') ?? ''))
    if (!list || !buttons.length || panels.some((panel) => !panel)) return

    const light = glowTabs(list, { palette: GREEN })
    const select = (index: number) => {
      buttons.forEach((button, i) => {
        const selected = i === index
        button.setAttribute('aria-selected', String(selected))
        button.tabIndex = selected ? 0 : -1
        panels[i]!.toggleAttribute('data-inactive', !selected)
      })
      light(buttons[index])
    }

    panels.forEach((panel, i) => {
      panel!.setAttribute('role', 'tabpanel')
      panel!.setAttribute('aria-labelledby', buttons[i].id)
      panel!.tabIndex = 0
    })

    list.addEventListener('click', (event) => {
      const index = buttons.indexOf((event.target as Element).closest<HTMLButtonElement>('[role="tab"]')!)
      if (index !== -1) select(index)
    })

    list.addEventListener('keydown', (event) => {
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (current === -1) return
      const last = buttons.length - 1
      const next =
        event.key === 'ArrowRight' ? (current === last ? 0 : current + 1)
        : event.key === 'ArrowLeft' ? (current === 0 ? last : current - 1)
        : event.key === 'Home' ? 0
        : event.key === 'End' ? last
        : -1
      if (next === -1) return
      event.preventDefault()
      select(next)
      buttons[next].focus()
    })

    select(Math.max(0, buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true')))
    list.hidden = false
    tabs.dataset.tabsReady = ''
  })
}
