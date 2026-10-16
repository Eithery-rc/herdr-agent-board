// Classify the press before a click handler can replace its DOM subtree.
export function eventWithin(event, selector) {
  return event.composedPath?.().some(node => node.matches?.(selector)) || !!event.target?.closest?.(selector)
}
export function panelPress(event, selector, menu = false) {
  return event.button === 0 ? { x: event.clientX, y: event.clientY, kept: eventWithin(event, selector), menu } : null
}
export function outsidePanelPress(down, click, selector) {
  return !!down && !down.menu && !down.kept && Math.hypot(click.clientX - down.x, click.clientY - down.y) <= 6 && !eventWithin(click, selector)
}
