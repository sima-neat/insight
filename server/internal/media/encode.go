package media

import (
	"math"
	"strconv"
)

// Encode is how Insight encodes a video so that the slots stream it with stream copy: with the
// published catalog's encoder settings (media-assets/build_media_assets.py), as a rendition at
// another frame rate or as an upload a board would stream badly. H.264 Constrained Baseline or
// H.265 Main, 8-bit 4:2:0, a keyframe every second, no B-frames, one reference frame, closed
// GOPs, the parameter sets and an access unit delimiter with every keyframe, at the bitrate
// VideoBitrate gives as both the target and the cap. The codec level is the encoder's own, the
// lowest that covers the stream: the catalog's table of levels covers only its own sizes and
// rates.
type Encode struct {
	// Codec is CodecH265, or CodecH264 for any other.
	Codec         string
	Width, Height int
	// FPS is the output's frame rate. With Resample the video is resampled to it, a whole number,
	// as a rendition is; without, it keeps its own rate, which FPS (0 when unknown) only says.
	FPS      float64
	Resample bool
}

// VideoBitrate is the catalog's bitrate in bit/s for a picture of width×height at fps (0 when
// unknown). The catalog goes by the height of its renditions, which are all landscape; going by
// the shorter side gives them the same and counts a portrait video as its landscape twin.
func VideoBitrate(width, height int, fps float64) int64 {
	side := min(width, height)
	switch {
	case side >= 2160:
		return 35_000_000
	case side >= 1080 && fps >= 100:
		return 18_000_000
	case side >= 1080:
		return 12_000_000
	case side >= 720 && fps >= 60:
		return 8_000_000
	case side >= 720 && fps > 0 && fps <= 20:
		return 2_000_000
	case side >= 720:
		return 5_000_000
	case side >= 480:
		return 3_000_000
	}
	return 1_000_000 // the catalog's 320p preview
}

// gop is one second of frames, 30 when the rate is unknown. It is held to 240, so that a rate
// ffprobe misreads (a variable-rate file's) cannot space the keyframes minutes apart.
func (e Encode) gop() int {
	if e.FPS <= 0 {
		return 30
	}
	return min(240, max(1, int(math.Round(e.FPS))))
}

// Args are ffmpeg's arguments to encode the first video stream of the file in, without audio,
// into the file out in the container format (ffmpeg's muxer: "mp4", "mov", "matroska"), with
// its progress on stdout.
func (e Encode) Args(in, out, format string) []string {
	gop := strconv.Itoa(e.gop())
	rate := strconv.FormatInt(VideoBitrate(e.Width, e.Height, e.FPS), 10)
	filter, tickRate := "setpts=PTS-STARTPTS", ""
	if e.Resample {
		fps := int(math.Round(e.FPS))
		filter += ",fps=" + strconv.Itoa(fps)
		// The stream's own timing for a reader that drops the container: H.264 counts fields,
		// so its tick rate is twice the frame rate.
		ticks := fps
		if e.Codec != CodecH265 {
			ticks *= 2
		}
		tickRate = ":tick_rate=" + strconv.Itoa(ticks) + "/1"
	}
	// "file:" so that no part of a file's name is read as a protocol.
	args := []string{
		"-y", "-nostdin", "-hide_banner", "-loglevel", "error",
		"-i", "file:" + in,
		"-map", "0:v:0", "-an",
		"-vf", filter,
	}
	if e.Resample {
		args = append(args, "-fps_mode", "cfr")
	}
	common := []string{
		"-pix_fmt", "yuv420p",
		"-g", gop, "-keyint_min", gop,
		"-bf", "0", "-flags", "+cgop",
		"-b:v", rate, "-maxrate", rate, "-bufsize", rate,
	}
	if e.Codec == CodecH265 {
		args = append(args, "-c:v", "libx265", "-preset", "medium", "-profile:v", "main")
		args = append(args, common...)
		args = append(args,
			"-tag:v", "hvc1",
			"-x265-params", "keyint="+gop+":min-keyint="+gop+":scenecut=0:bframes=0:ref=1:open-gop=0:repeat-headers=1:log-level=error",
			"-bsf:v", "hevc_metadata=aud=remove,hevc_metadata=aud=insert"+tickRate,
		)
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "medium", "-profile:v", "baseline",
			"-refs", "1", "-sc_threshold", "0")
		args = append(args, common...)
		args = append(args,
			"-x264-params", "repeat-headers=1:force-cfr=1:open-gop=0",
			"-tag:v", "avc1",
			"-bsf:v", "h264_metadata=aud=remove,dump_extra=freq=keyframe,h264_metadata=aud=insert"+tickRate,
		)
	}
	if format == "mp4" || format == "mov" {
		args = append(args, "-movflags", "+faststart")
	}
	return append(args,
		"-avoid_negative_ts", "make_zero",
		"-progress", "pipe:1", "-nostats",
		"-f", format, "file:"+out,
	)
}
