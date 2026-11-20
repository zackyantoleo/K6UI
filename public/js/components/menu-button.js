// A button that opens a small menu of actions (the top bar's Import menu).
// Keyboard: Enter, Space or Arrow Down opens it on the first item, Arrow Up on
// the last; arrows, Home and End move; Escape closes it and returns focus to the
// button; Tab or a click outside closes it. Menus made per request card pass
// `closeOnOutsideClick: false` and close through one shared listener instead
// (a listener per card would outlive the card).
export function initMenuButton(button, menu, { closeOnOutsideClick = true } = {}) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];

  function open(index = 0) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const list = items();
    list[(index + list.length) % list.length]?.focus();
  }
  function close({ focusButton = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  }

  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); open(0); }
    if (event.key === 'ArrowUp') { event.preventDefault(); open(-1); }
  });
  menu.addEventListener('keydown', event => {
    const list = items();
    const current = list.indexOf(document.activeElement);
    const moves = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: list.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      list[(moves[event.key] + list.length) % list.length].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ focusButton: true });
    } else if (event.key === 'Tab') {
      close();
    }
  });
  // Capture phase: the menu closes and focus returns to the button before the
  // item's own handler runs, so a dialog it opens returns focus to the button.
  menu.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[role="menuitem"]')) close({ focusButton: true });
  }, true);
  if (closeOnOutsideClick) document.addEventListener('click', event => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  return { open, close };
}
