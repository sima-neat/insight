import { orientationInputs } from './orientation';

describe('orientationInputs', () => {
  it('maps each orientation onto mirror and flipVertical', () => {
    expect(orientationInputs('none')).toStrictEqual({ mirror: false, flipVertical: false });
    expect(orientationInputs('mirror')).toStrictEqual({ mirror: true, flipVertical: false });
    expect(orientationInputs('flip-vertical')).toStrictEqual({ mirror: false, flipVertical: true });
    // The kit's tile turns the picture 180° with both.
    expect(orientationInputs('rotate-180')).toStrictEqual({ mirror: true, flipVertical: true });
  });
});
