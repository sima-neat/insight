import type { Orientation } from './settings/schema';

/**
 * The kit tile's `mirror` and `flipVertical` for an orientation. The tile has no rotation of its
 * own: both flips together are the picture turned 180°.
 */
export function orientationInputs(orientation: Orientation): {
  mirror: boolean;
  flipVertical: boolean;
} {
  return {
    mirror: orientation === 'mirror' || orientation === 'rotate-180',
    flipVertical: orientation === 'flip-vertical' || orientation === 'rotate-180',
  };
}
