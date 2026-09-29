import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useFactsFit } from './useFactsFit';

// `revision` only forces a render: the footer re-renders with every streamed
// update even when nothing it shows changed.
const Footer: React.FC<{ duration: string; revision: number }> = ({ duration }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  useFactsFit(ref);
  return (
    <div ref={ref}>
      <span data-fact-model>model name</span>
      <span data-fact-priority="1">{duration}</span>
    </div>
  );
};

test('fits again only when the footer markup changed', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    ResizeObserver: happyWindow.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => { root.render(<Footer duration="1s" revision={0} />); });
    const model = container.querySelector<HTMLElement>('[data-fact-model]');
    const fact = container.querySelector<HTMLElement>('[data-fact-priority]');
    if (!model || !fact) throw new Error('Expected the footer facts');

    // The model is truncated while the fact is visible and whole once it hides.
    let layoutReads = 0;
    Object.defineProperties(model, {
      clientWidth: { configurable: true, get: () => 100 },
      scrollWidth: {
        configurable: true,
        get: () => {
          layoutReads += 1;
          return fact.style.display === 'none' ? 100 : 160;
        },
      },
    });

    await act(async () => { root.render(<Footer duration="1s" revision={1} />); });
    expect(layoutReads).toBe(0);

    await act(async () => { root.render(<Footer duration="2s" revision={2} />); });
    expect(layoutReads).toBeGreaterThan(0);
    expect(fact.style.display).toBe('none');

    const readsAfterFit = layoutReads;
    await act(async () => { root.render(<Footer duration="2s" revision={3} />); });
    expect(layoutReads).toBe(readsAfterFit);
    expect(fact.style.display).toBe('none');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await happyWindow.happyDOM.close();
  }
});
