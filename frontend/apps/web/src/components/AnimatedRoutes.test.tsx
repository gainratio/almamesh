/**
 * AnimatedRoutes must not leave animation work running after it unmounts.
 *
 * It used to import the GSAP storytelling barrel just to call
 * `killAllScrollTriggers()`. Importing ScrollTrigger in a browser enables it,
 * which arms a 250 ms `setInterval` for the life of the page (plus scroll,
 * wheel and pointer listeners), on every page, although no page creates a
 * ScrollTrigger. In the unit suite that interval fired after the DOM was torn
 * down ("requestAnimationFrame is not defined") and failed CI at random.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { describeLiveTimers, liveTimers, type LiveTimer } from '../test/liveTimers';
import { getScrollTrigger, isGSAPLoaded, loadGSAP } from '../animations/storytelling/lazyLoad';
import { AnimatedRoutes } from './AnimatedRoutes';

function renderTwoRoutes() {
  return render(
    <MemoryRouter initialEntries={['/a']}>
      <AnimatedRoutes>
        <Route path="/a" element={<Link to="/b">go to b</Link>} />
        <Route path="/b" element={<p>page b</p>} />
      </AnimatedRoutes>
    </MemoryRouter>,
  );
}

function armedByGsap(timer: LiveTimer): boolean {
  return timer.createdAt.includes('/gsap/');
}

async function navigateToB(): Promise<void> {
  fireEvent.click(screen.getByText('go to b'));
  // AnimatePresence mode="wait": page b mounts once page a's exit completes.
  expect(await screen.findByText('page b')).toBeTruthy();
}

describe('AnimatedRoutes teardown', () => {
  afterEach(() => {
    if (isGSAPLoaded()) getScrollTrigger().disable(false, true);
  });

  it('leaves no interval, GSAP frame callback or GSAP tween behind after navigating and unmounting', async () => {
    const view = renderTwoRoutes();
    await navigateToB();
    view.unmount();

    const intervals = liveTimers(['interval']);
    expect(intervals, describeLiveTimers(intervals)).toEqual([]);
    const gsapFrames = liveTimers(['animationFrame']).filter(armedByGsap);
    expect(gsapFrames, describeLiveTimers(gsapFrames)).toEqual([]);
    // Imported only now: loading GSAP wakes its ticker, which would itself
    // leave a frame callback pending.
    const { gsap } = await import('gsap');
    expect(gsap.globalTimeline.getChildren(true, true, true)).toEqual([]);
  });

  it('still kills ScrollTriggers on route change once a page has loaded GSAP', async () => {
    const { ScrollTrigger } = await loadGSAP();
    renderTwoRoutes();
    await act(async () => {
      ScrollTrigger.create({ trigger: document.body });
    });
    expect(ScrollTrigger.getAll()).toHaveLength(1);

    await navigateToB();

    expect(ScrollTrigger.getAll()).toHaveLength(0);
  });
});
