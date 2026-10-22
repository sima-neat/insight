import { NeatNavItem } from '@sima/neat-ui';

/** The shell's rail, in display order; every path is a route in `app.routes.ts`. */
export const INSIGHT_NAV: NeatNavItem[] = [
  { label: 'Media', icon: 'media', path: '/media' },
  { label: 'Streaming', icon: 'streaming', path: '/streaming' },
  { label: 'Viewer', icon: 'viewer', path: '/viewer' },
  { label: 'Peripherals', icon: 'peripherals', path: '/peripherals' },
  { label: 'Stats', icon: 'stats', path: '/stats' },
];
