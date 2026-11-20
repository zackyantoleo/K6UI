// Tiny querySelector helpers — used across the whole frontend.
export const $  = (s, ctx = document) => ctx.querySelector(s);
export const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));

// A new element with an optional class and text. The text is set as textContent,
// never parsed as markup, so project data is always safe to pass.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}
