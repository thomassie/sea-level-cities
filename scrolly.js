/* Scrollytelling: text steps scroll past a held graphic; the graphic follows the active step.
   Same pattern as europes-divides/site/syria (syr.js): the active step is the last one whose text has passed a
   line in the viewport (62% of its height when wide, 82% when narrow), checked on scroll in requestAnimationFrame.
   No library. Canonical copy: site/_shared/scrolly.js (tools/sync_shared.py copies it into each page).

   FCC.scrolly({ root, steps: '.step', narrowAt: 860, onStep(i, el, { direction }) {}, onProgress(i, p) {} })
     root        element that holds the steps (its width decides wide/narrow)
     onStep      called when the active step changes (direction: 1 down, -1 up)
     onProgress  optional, called on every scroll frame with the active step and 0..1 progress through it,
                 for continuous effects such as water rising while a step is read
   Returns { refresh(), active() }. */
(function (g) {
  'use strict';
  const FCC = g.FCC || (g.FCC = {});
  FCC.scrolly = function ({ root, steps = '.step', narrowAt = 860, onStep, onProgress }) {
    const els = [...root.querySelectorAll(steps)];
    let active = -1, ticking = false;
    function pick(force) {
      const narrow = root.clientWidth <= narrowAt;
      const line = window.innerHeight * (narrow ? 0.82 : 0.62);
      let k = 0;
      els.forEach((el, i) => { if ((el.firstElementChild || el).getBoundingClientRect().top < line) k = i; });
      if (k !== active || force) {
        const direction = k >= active ? 1 : -1;
        active = k;
        els.forEach((el, i) => el.classList.toggle('is-active', i === k));
        if (onStep) onStep(k, els[k], { direction });
      }
      if (onProgress && els[k]) {
        const r = els[k].getBoundingClientRect();
        onProgress(k, Math.min(1, Math.max(0, (line - r.top) / Math.max(1, r.height))));
      }
    }
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; pick(false); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    pick(true);
    return { refresh: () => pick(true), active: () => active };
  };
})(window);
