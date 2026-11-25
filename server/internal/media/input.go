package media

// What an ffmpeg or ffprobe input may open. An input opens more than its own URL: an HLS
// playlist opens the segments it names, and a library file is whatever was uploaded. So each
// input names the protocols its kind needs, and ffmpeg refuses any other (`Protocol 'http' not
// on whitelist 'file'!`). ffmpeg 6 already keeps a local file to file, crypto and data by
// default; saying it here keeps it so on any ffmpeg on PATH. Each is the input's options and
// its -i, last. What a playlist can still reach on the machine, ProbeFile refuses.

// FileInput is the input of the local file at abs, as a file and only that: "file:" so that no
// part of its name is read as a protocol, and only the file protocol for what it opens.
func FileInput(abs string) []string {
	return []string{"-protocol_whitelist", "file", "-i", "file:" + abs}
}

// RTSPInput is the input of an RTSP stream (a camera's, or one of MediaMTX's paths) over TCP:
// tcp for rtsp://, and tls over it for rtsps://.
func RTSPInput(url string) []string {
	return []string{"-protocol_whitelist", "tcp,tls", "-rtsp_transport", "tcp", "-i", url}
}
