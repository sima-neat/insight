import {
  catalogProgress,
  failureText,
  isProgressFailure,
  mergePrepareProgress,
  prepareProgress,
  uploadProgress,
  youtubeProgress,
  type Progress,
} from './progress-lines';

describe('uploadProgress', () => {
  it('reads the optimising percent and its elapsed / total time', () => {
    expect(uploadProgress('Optimizing clip.mp4: 42% (00:10 / 00:25)')).toEqual({
      title: 'Preparing media',
      detail: '00:10 / 00:25',
      percent: 42,
    });
  });

  it('shows the elapsed time alone when the duration is unknown', () => {
    expect(uploadProgress('Optimizing clip.mp4: 00:10 processed')).toEqual({
      title: 'Preparing media',
      detail: '00:10 processed',
      percent: null,
    });
  });

  it('names the file when optimising starts', () => {
    expect(uploadProgress('Optimizing a/clip.mp4 for low-latency RTSP playback...')).toEqual({
      title: 'Preparing media',
      detail: 'a/clip.mp4',
      percent: null,
    });
  });

  it('reports the file an archive scan is on', () => {
    expect(uploadProgress('Preparing file 2/5: folder/clip.mp4')).toEqual({
      title: 'Scanning upload',
      detail: 'File 2/5: folder/clip.mp4',
      percent: null,
    });
  });

  it('marks an optimised file as prepared', () => {
    expect(
      uploadProgress(
        'Optimized clip.mp4: H.264 baseline, GOP 30, B-frames disabled, source frame rate preserved.',
      ),
    ).toEqual({ title: 'Prepared media', detail: 'clip.mp4', percent: 100 });
  });

  it('reports a saved and an extracted archive', () => {
    expect(uploadProgress('Saved archive to /media/set/set.zip')).toEqual({
      title: 'Uploading archive',
      detail: '',
      percent: null,
    });
    expect(uploadProgress('Archive extracted.')).toEqual({
      title: 'Archive extracted',
      detail: '',
      percent: null,
    });
  });

  it('shows any other line as it is', () => {
    expect(uploadProgress('Keeping clip.mp4 as H264 for codec-aware streaming.')).toEqual({
      title: 'Uploading media',
      detail: 'Keeping clip.mp4 as H264 for codec-aware streaming.',
      percent: null,
    });
    expect(uploadProgress('Upload complete.')).toEqual({
      title: 'Uploading media',
      detail: 'Upload complete.',
      percent: null,
    });
  });

  it('has nothing to show for a blank line, and ignores surrounding whitespace', () => {
    expect(uploadProgress('')).toBeNull();
    expect(uploadProgress('  \r')).toBeNull();
    expect(uploadProgress('  Archive extracted.\r')).toMatchObject({ title: 'Archive extracted' });
  });
});

describe('catalogProgress', () => {
  it('reads the percent and shows the bytes in MB', () => {
    expect(catalogProgress('Downloading catalog asset: 27% (12897485 / 47815066 bytes)')).toEqual({
      title: 'Importing catalog asset',
      detail: '12.3 / 45.6 MB',
      percent: 27,
    });
  });

  it('shows bytes in MB when the total is unknown', () => {
    expect(catalogProgress('Downloading catalog asset: 1572864 bytes downloaded')).toEqual({
      title: 'Importing catalog asset',
      detail: '1.5 MB downloaded',
      percent: null,
    });
  });

  it('shows the announcement line that names the asset', () => {
    expect(catalogProgress('Downloading catalog asset: Street 720p30 h264')).toEqual({
      title: 'Importing catalog asset',
      detail: 'Street 720p30 h264',
      percent: null,
    });
  });

  it('reports the saved path and the completion', () => {
    expect(
      catalogProgress('Saved catalog asset to catalog/street/street_720p_30fps_h264.mp4'),
    ).toEqual({
      title: 'Catalog asset saved',
      detail: 'catalog/street/street_720p_30fps_h264.mp4',
      percent: 100,
    });
    expect(catalogProgress('Catalog import complete.')).toEqual({
      title: 'Catalog import complete',
      detail: '',
      percent: 100,
    });
  });

  it('shows any other line as it is', () => {
    expect(catalogProgress('Waiting for the catalog')).toEqual({
      title: 'Importing catalog asset',
      detail: 'Waiting for the catalog',
      percent: null,
    });
    expect(catalogProgress('')).toBeNull();
  });
});

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

describe('prepareProgress', () => {
  it('reads the seconds encoded, the total and the percent', () => {
    expect(prepareProgress('progress 12.5/60.0')).toEqual({
      title: 'Encoding rendition…',
      detail: '12.5 / 60.0 s',
      percent: 20,
    });
  });

  it('never reaches 100 before the rendition is ready', () => {
    expect(prepareProgress('progress 30.0/60.0')).toMatchObject({ percent: 50 });
    expect(prepareProgress('progress 60.0/60.0')).toMatchObject({ percent: 99 });
    expect(prepareProgress('progress 61.0/60.0')).toMatchObject({ percent: 99 });
  });

  it('shows the seconds alone when the total is unknown or zero', () => {
    expect(prepareProgress('progress 12.5')).toEqual({
      title: 'Encoding rendition…',
      detail: '12.5 s',
      percent: null,
    });
    expect(prepareProgress('progress 12.5/0.0')).toEqual({
      title: 'Encoding rendition…',
      detail: '12.5 s',
      percent: null,
    });
  });

  it('reads the frame rate and encoder when encoding starts', () => {
    expect(prepareProgress('Encoding a/clip.mp4 at 15 fps (libx264)...')).toEqual({
      title: 'Encoding 15 fps rendition…',
      detail: 'libx264',
      percent: null,
    });
  });

  it('reports a reused and a finished rendition', () => {
    expect(prepareProgress('Reusing rendition: .renditions/ab12_15fps.mp4')).toEqual({
      title: 'Reusing rendition',
      detail: '.renditions/ab12_15fps.mp4',
      percent: null,
    });
    expect(prepareProgress('Rendition ready: .renditions/ab12_15fps.mp4')).toEqual({
      title: 'Rendition ready',
      detail: '.renditions/ab12_15fps.mp4',
      percent: null,
    });
  });

  it('shows the waiting and no-rendition lines as the title', () => {
    expect(prepareProgress('Waiting for another rendition to finish encoding…')).toEqual({
      title: 'Waiting for another rendition to finish encoding…',
      detail: '',
      percent: null,
    });
    expect(prepareProgress('Source frame rate matches; no rendition needed.')).toEqual({
      title: 'Source frame rate matches; no rendition needed.',
      detail: '',
      percent: null,
    });
    expect(prepareProgress('')).toBeNull();
  });
});

describe('failure lines', () => {
  // The server answers 200 and prints these in the body, so the parsers are the only way to
  // tell a failed stream from a finished one. #170 recognised only the two FFmpeg lines.
  const upload = [
    'No file provided.',
    'Failed to extract archive: File is not a zip file',
    'FFmpeg conversion failed for clip.mp4: Invalid data found when processing input',
    'FFmpeg is not installed; keeping original clip.mp4.',
    'FFprobe is not installed; keeping original clip.mp4 because the codec cannot be detected.',
  ];
  const catalog = [
    'Catalog import failed: HTTP Error 404: Not Found',
    'Checksum mismatch for catalog asset: expected aa, got bb',
    'Size mismatch for catalog asset: expected 100 bytes, got 99',
  ];
  const youtube = [
    'YouTube import failed: ERROR: Video unavailable',
    'YouTube import failed: no downloaded media file was produced.',
    'YouTube import failed: ffmpeg is not installed.',
  ];

  it.each(upload)('upload: %s', (line) => {
    expect(uploadProgress(line)).toEqual({ failed: line });
  });

  it.each(catalog)('catalog: %s', (line) => {
    expect(catalogProgress(line)).toEqual({ failed: line });
  });

  it.each(youtube)('youtube: %s', (line) => {
    expect(youtubeProgress(line)).toEqual({ failed: line });
  });

  it('prepare: reports the message of an Error line without its prefix', () => {
    expect(prepareProgress('Error: ffmpeg exited with status 1')).toEqual({
      failed: 'ffmpeg exited with status 1',
    });
  });

  it('prepare: gives a bare Error line a message', () => {
    expect(prepareProgress('Error:')).toEqual({ failed: 'The server reported an error.' });
  });

  it('trims the line it reports', () => {
    expect(catalogProgress('  Catalog import failed: boom \r')).toEqual({
      failed: 'Catalog import failed: boom',
    });
  });

  it('tells a failure from progress', () => {
    expect(isProgressFailure({ failed: 'x' })).toBe(true);
    expect(isProgressFailure({ title: 'x', detail: '', percent: null })).toBe(false);
  });
});

describe('mergePrepareProgress', () => {
  const encoding = 'Encoding a/clip.mp4 at 15 fps (libx264)...';

  it('keeps the encoding title and encoder when a progress line arrives', () => {
    const started = mergePrepareProgress(null, encoding);
    expect(started).toEqual({
      title: 'Encoding 15 fps rendition…',
      detail: 'libx264',
      percent: null,
    });

    expect(mergePrepareProgress(started as Progress, 'progress 12.5/60.0')).toEqual({
      title: 'Encoding 15 fps rendition…',
      detail: 'libx264',
      percent: 20,
    });
  });

  it('keeps following the percent through later progress lines', () => {
    let state = mergePrepareProgress(null, encoding);
    state = mergePrepareProgress(state as Progress, 'progress 12.5/60.0');
    state = mergePrepareProgress(state as Progress, 'progress 30.0/60.0');
    expect(state).toMatchObject({ title: 'Encoding 15 fps rendition…', percent: 50 });
  });

  it('shows a progress line as it is when no encoding line came first', () => {
    expect(mergePrepareProgress(null, 'progress 12.5/60.0')).toEqual(
      prepareProgress('progress 12.5/60.0'),
    );
    const waiting = mergePrepareProgress(null, 'Waiting for another rendition to finish encoding…');
    expect(mergePrepareProgress(waiting as Progress, 'progress 1.0/60.0')).toEqual(
      prepareProgress('progress 1.0/60.0'),
    );
  });

  it('replaces the display for any other line, and reports failures', () => {
    const encoding15 = mergePrepareProgress(null, encoding) as Progress;
    expect(mergePrepareProgress(encoding15, 'Rendition ready: .renditions/a.mp4')).toEqual({
      title: 'Rendition ready',
      detail: '.renditions/a.mp4',
      percent: null,
    });
    expect(mergePrepareProgress(encoding15, 'Error: boom')).toEqual({ failed: 'boom' });
  });

  it('leaves the display as it was for a blank line', () => {
    const encoding15 = mergePrepareProgress(null, encoding) as Progress;
    expect(mergePrepareProgress(encoding15, '')).toBe(encoding15);
    expect(mergePrepareProgress(null, '')).toBeNull();
  });
});

describe('failureText', () => {
  it('is null when nothing failed', () => {
    expect(
      failureText(['Preparing file 1/1: a.mp4', 'Optimized a.mp4: H.264', 'Upload complete.']),
    ).toBeNull();
    expect(failureText([])).toBeNull();
  });

  it('gives a one-line failure as it is', () => {
    expect(
      failureText(['Uploaded to /media/a.mp4', 'FFmpeg is not installed; keeping original a.mp4.']),
    ).toBe('FFmpeg is not installed; keeping original a.mp4.');
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

  it('stops at the next line the server prints, so an archive carries on past a failed file', () => {
    expect(
      failureText([
        'Preparing file 1/2: a.mp4',
        'FFmpeg conversion failed for a.mp4: moov atom not found',
        'Invalid data found when processing input',
        'Preparing file 2/2: b.mp4',
        'FFmpeg conversion failed for b.mp4: second',
        'Upload complete.',
      ]),
    ).toBe(
      'FFmpeg conversion failed for a.mp4: moov atom not found\nInvalid data found when processing input',
    );
  });

  it('gives an Error line without its prefix', () => {
    expect(
      failureText(['Encoding a.mp4 at 15 fps (libx264)...', 'Error: ffmpeg exited with status 1']),
    ).toBe('ffmpeg exited with status 1');
    expect(failureText(['Error:'])).toBe('The server reported an error.');
  });

  it('ignores blank lines and surrounding whitespace', () => {
    expect(failureText(['', '  Catalog import failed: boom \r', ''])).toBe(
      'Catalog import failed: boom',
    );
  });
});
