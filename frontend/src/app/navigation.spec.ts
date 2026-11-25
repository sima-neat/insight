import { routes } from './app.routes';
import { INSIGHT_NAV } from './navigation';

describe('INSIGHT_NAV', () => {
  it('lists Media, Streaming, Viewer, Peripherals, Stats in that order, each path matching a route', () => {
    expect(INSIGHT_NAV).toEqual([
      { label: 'Media', icon: 'media', path: '/media' },
      { label: 'Streaming', icon: 'streaming', path: '/streaming' },
      { label: 'Viewer', icon: 'viewer', path: '/viewer' },
      { label: 'Peripherals', icon: 'peripherals', path: '/peripherals' },
      {
        label: 'Stats',
        icon: 'stats',
        path: '/stats',
        children: [
          { label: 'Live', path: '/stats' },
          { label: 'Runs', path: '/stats/runs' },
        ],
      },
    ]);

    for (const item of INSIGHT_NAV) {
      const route = routes.find((candidate) => `/${candidate.path}` === item.path);
      expect(route?.loadComponent, item.path).toBeDefined();
      // The shell shows the label as the page title and the route sets the document title.
      expect(route?.title, item.path).toBe(item.label);
    }
  });
});
