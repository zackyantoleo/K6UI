// Tiny querySelector helpers — used across the whole frontend.
export const $  = (s, ctx = document) => ctx.querySelector(s);
export const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));
