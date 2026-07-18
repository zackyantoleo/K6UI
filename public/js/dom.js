// Helper singkat querySelector — dipakai di seluruh frontend.
export const $  = (s, ctx = document) => ctx.querySelector(s);
export const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));
