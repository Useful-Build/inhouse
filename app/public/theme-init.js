// Apply the saved theme before first paint (src/lib/theme.ts owns the key).
// A blocked or failing storage read falls back to the system preference.
// External file, not inline, so the CSP can keep script-src 'self'.
try {
  var t = null
  try { t = localStorage.getItem('inhouse.theme') } catch {}
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark')
} catch {}
