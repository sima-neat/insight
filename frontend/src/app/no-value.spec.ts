import { neatDuration } from '@sima/neat-ui';
import { NO_VALUE } from './no-value';

describe('NO_VALUE', () => {
  it("is the kit's own mark for a missing value", () => {
    expect(NO_VALUE).toBe(neatDuration(null));
  });
});
