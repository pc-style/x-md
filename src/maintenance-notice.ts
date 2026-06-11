const STORAGE_KEY = 'xmd-maintenance-notice-dismissed'

export function setupMaintenanceNotice() {
  if (sessionStorage.getItem(STORAGE_KEY)) return

  const overlay = document.createElement('div')
  overlay.className = 'maintenance-overlay'
  overlay.setAttribute('role', 'presentation')

  overlay.innerHTML = `
    <div
      class="maintenance-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="maintenance-title"
      aria-describedby="maintenance-desc"
    >
      <div class="maintenance-dialog-glow" aria-hidden="true"></div>
      <p class="eyebrow eyebrow-accent mb-3">Maintenance</p>
      <h2 id="maintenance-title" class="maintenance-title">Work in progress</h2>
      <p id="maintenance-desc" class="maintenance-desc">
        We're shipping updates right now. You might hit errors or find the service temporarily unavailable — we'll be back in a few hours.
      </p>
      <button type="button" class="maintenance-dismiss btn-primary" data-maintenance-dismiss>
        I understand
      </button>
    </div>
  `

  const dismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, '1')
    overlay.classList.add('maintenance-overlay--closing')
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true })
    setTimeout(() => overlay.remove(), 320)
  }

  overlay.querySelector<HTMLButtonElement>('[data-maintenance-dismiss]')?.addEventListener('click', dismiss)

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('maintenance-overlay--visible'))
}
