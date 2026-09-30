export function append<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = parent.ownerDocument.createElement(tag);
  if (className) el.className = className;
  parent.appendChild(el);
  return el;
}
