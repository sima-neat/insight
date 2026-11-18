import { failureText, isProgressFailure, savedPath, youtubeProgress } from './progress-lines';

describe('youtubeProgress', () => {
  it('reads the clip capture percent and its time', () => {
    expect(youtubeProgress('Capturing YouTube clip: 40% (00:12 / 00:30)')).toEqual({
      title: 'Capturing YouTube clip',
      detail: '00:12 / 00:30',
      percent: 40,
    });
  });

  it('shows a capture line without a percent as pending', () => {
    expect(youtubeProgress('Capturing YouTube clip: waiting for first media data.')).toEqual({
      title: 'Capturing YouTube clip',
      detail: 'waiting for first media data.',
      percent: null,
    });
  });

  it('reads the download percent', () => {
    expect(youtubeProgress('Downloading YouTube video: 37%')).toEqual({
      title: 'Downloading YouTube video',
      detail: '',
      percent: 37,
    });
  });

  it('shows the download wait as pending', () => {
    expect(
      youtubeProgress(
        'Downloading YouTube video: waiting for first media data. This can take a while; please wait. 720p30 source, 00:00-05:00',
      ),
    ).toEqual({
      title: 'Downloading YouTube video',
      detail:
        'waiting for first media data. This can take a while; please wait. 720p30 source, 00:00-05:00',
      percent: null,
    });
  });

  it('reads the preparing percent, the elapsed time alone, and the start line', () => {
    expect(youtubeProgress('Preparing YouTube media: 50% (00:20 / 00:40)')).toEqual({
      title: 'Preparing YouTube media',
      detail: '00:20 / 00:40',
      percent: 50,
    });
    expect(youtubeProgress('Preparing YouTube media: 00:05 processed')).toEqual({
      title: 'Preparing YouTube media',
      detail: '00:05 processed',
      percent: null,
    });
    expect(youtubeProgress('Preparing YouTube media: 720p30 H.264')).toEqual({
      title: 'Preparing YouTube media',
      detail: '720p30 H.264',
      percent: null,
    });
  });

  it('reports the saved path and the completion', () => {
    expect(
      youtubeProgress('Saved YouTube media to youtube/youtube_abc_720p30_s0_d300_h264.mp4'),
    ).toEqual({
      title: 'YouTube media saved',
      detail: 'youtube/youtube_abc_720p30_s0_d300_h264.mp4',
      percent: 100,
    });
    expect(youtubeProgress('YouTube import complete.')).toEqual({
      title: 'YouTube import complete',
      detail: '',
      percent: 100,
    });
  });

  it('shows any other line as it is', () => {
    expect(youtubeProgress('Validating YouTube video: abc123')).toEqual({
      title: 'Importing YouTube video',
      detail: 'Validating YouTube video: abc123',
      percent: null,
    });
    expect(youtubeProgress('')).toBeNull();
  });
});

describe('failure lines', () => {
  // The server answers 200 and prints these in the body, so the parser is the only way to tell a
  // failed stream from a finished one.
  it.each([
    'YouTube import failed: ERROR: Video unavailable',
    'YouTube import failed: no downloaded media file was produced.',
    'YouTube import failed: ffmpeg is not installed.',
  ])('youtube: %s', (line) => {
    expect(youtubeProgress(line)).toEqual({ failed: line });
  });

  it('trims the line it reports', () => {
    expect(youtubeProgress('  YouTube import failed: boom \r')).toEqual({
      failed: 'YouTube import failed: boom',
    });
  });

  it('tells a failure from progress', () => {
    expect(isProgressFailure({ failed: 'x' })).toBe(true);
    expect(isProgressFailure({ title: 'x', detail: '', percent: null })).toBe(false);
  });
});

describe('failureText', () => {
  it('is null when nothing failed', () => {
    expect(
      failureText([
        'Downloading YouTube video: 100%',
        'Saved YouTube media to youtube/a.mp4',
        'YouTube import complete.',
      ]),
    ).toBeNull();
    expect(failureText([])).toBeNull();
  });

  it('gives a one-line failure as it is', () => {
    expect(
      failureText([
        'Downloading YouTube video: 12%',
        'YouTube import failed: ffmpeg is not installed.',
      ]),
    ).toBe('YouTube import failed: ffmpeg is not installed.');
  });

  it('adds the diagnostic lines the server prints under a failure', () => {
    expect(
      failureText([
        'Downloading YouTube video: 12%',
        'YouTube import failed: ERROR: unable to download video data',
        'HTTP Error 403: Forbidden',
        '[download] giving up after 3 retries',
      ]),
    ).toBe(
      'YouTube import failed: ERROR: unable to download video data\nHTTP Error 403: Forbidden\n[download] giving up after 3 retries',
    );
  });

  it('stops at the next line the server prints', () => {
    expect(
      failureText([
        'YouTube import failed: ERROR: unable to download video data',
        'HTTP Error 403: Forbidden',
        'Downloading YouTube video: retrying',
      ]),
    ).toBe(
      'YouTube import failed: ERROR: unable to download video data\nHTTP Error 403: Forbidden',
    );
  });

  it('ignores blank lines and surrounding whitespace', () => {
    expect(failureText(['', '  YouTube import failed: boom \r', ''])).toBe(
      'YouTube import failed: boom',
    );
  });
});

describe('savedPath', () => {
  it('gives the library path a YouTube import prints', () => {
    expect(savedPath('Saved YouTube media to youtube/youtube_abc_720p30_s0_d60_h264.mp4')).toBe(
      'youtube/youtube_abc_720p30_s0_d60_h264.mp4',
    );
  });

  it('is null for any other line', () => {
    expect(savedPath('YouTube import complete.')).toBeNull();
    expect(savedPath('Downloading YouTube video: 12%')).toBeNull();
  });
});
