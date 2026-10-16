// The viewer's choice of light or dark (Settings), before the page paints, so it never flashes
// the other one. Without a choice the page follows the system. Kept in this browser.
try {
  const theme = localStorage.getItem('board.theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch {}
