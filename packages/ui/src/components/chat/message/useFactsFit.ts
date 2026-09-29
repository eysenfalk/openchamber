import React from 'react';

/**
 * Keeps the assistant footer's facts on one line by dropping the least
 * important ones until the rest fit.
 *
 * The row itself never overflows — the model name truncates instead — so "did
 * it fit" is read off the model, and facts marked `data-fact-priority` are
 * hidden in that order (1 goes first) until the model is whole again. That is
 * the rule the design asks for: the timestamp goes, then the agent, then the
 * thinking effort, and only a row with nothing left to give truncates the
 * model.
 *
 * CSS alone cannot do this. Hiding on container-width breakpoints guesses at
 * the model's length and drops facts that would have fitted, and wrapping the
 * overflow onto a clipped second line leaves the dropped fact's width behind as
 * a hole in the middle of the row.
 *
 * Measuring forces a synchronous layout, so it runs only when the row's markup
 * changed since the last fit or the row was resized: a footer re-rendered with
 * the same content (every mounted footer, on every streamed update) costs a
 * string comparison instead of a layout.
 */
export const useFactsFit = (ref: React.RefObject<HTMLElement | null>): void => {
  const applyRef = React.useRef<() => void>(() => {});
  const fittedMarkupRef = React.useRef<string | null>(null);

  applyRef.current = () => {
    const container = ref.current;
    if (!container) return;

    const model = container.querySelector<HTMLElement>('[data-fact-model]');
    if (!model) return;

    const facts = Array.from(container.querySelectorAll<HTMLElement>('[data-fact-priority]'))
      .sort((left, right) => Number(left.dataset.factPriority) - Number(right.dataset.factPriority));

    for (const fact of facts) fact.style.display = '';

    const modelFits = () => model.scrollWidth <= model.clientWidth + 1;
    for (const fact of facts) {
      if (modelFits()) break;
      fact.style.display = 'none';
    }
    // Read after hiding, so the next unchanged render matches it.
    fittedMarkupRef.current = container.innerHTML;
  };

  // After a render that changed the row: the facts change while a turn
  // finishes (the duration keeps counting), and that changes what fits without
  // changing any box the observer below watches.
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container || container.innerHTML === fittedMarkupRef.current) return;
    applyRef.current();
  });

  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;

    let inCallback = false;
    const refit = () => {
      // Hiding a fact never resizes the row (its width comes from the layout
      // above it), but guard the re-entry anyway.
      if (inCallback) return;
      inCallback = true;
      applyRef.current();
      inCallback = false;
    };

    // The window covers the common cases (a desktop window resized, a phone
    // rotated); the observer covers the ones that leave the window alone —
    // a sidebar opening, a panel dragged wider.
    window.addEventListener('resize', refit);
    const observer = new ResizeObserver(refit);
    observer.observe(container);
    return () => {
      window.removeEventListener('resize', refit);
      observer.disconnect();
    };
  }, [ref]);
};
