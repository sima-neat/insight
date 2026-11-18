package slots

import (
	"fmt"
	"net/http"

	"insight/internal/media"
)

// A rendition is encoded with the catalog's encoder settings (media-assets/build_media_assets.py),
// so that it streams with stream copy as a catalog asset does: a bitrate by height and rate, and
// the lowest codec level that covers the picture size, throughput and bitrate.

// codecLevel is one level of a codec: its name and its limits on picture size, throughput (per
// second) and bitrate in bit/s.
type codecLevel struct {
	name                string
	maxPicture, maxRate int64
	maxBitrate          int64
}

// H.264 (ITU-T H.264 Annex A, table A-1, Baseline/Main/Extended) counts 16×16 macroblocks.
var h264Levels = []codecLevel{
	{"3.0", 1620, 40500, 10_000_000},
	{"3.1", 3600, 108000, 14_000_000},
	{"3.2", 5120, 216000, 20_000_000},
	{"4.0", 8192, 245760, 20_000_000},
	{"4.2", 8704, 522240, 50_000_000},
	{"5.0", 22080, 589824, 135_000_000},
	{"5.1", 36864, 983040, 240_000_000},
	{"5.2", 36864, 2073600, 240_000_000},
	{"6.0", 139264, 4177920, 240_000_000},
	{"6.1", 139264, 8355840, 480_000_000},
	{"6.2", 139264, 16711680, 800_000_000},
}

// H.265 (ITU-T H.265 Annex A, tables A-8 and A-9, Main tier) counts luma samples.
var h265Levels = []codecLevel{
	{"3.0", 552960, 16588800, 6_000_000},
	{"3.1", 983040, 33177600, 10_000_000},
	{"4.0", 2228224, 66846720, 12_000_000},
	{"4.1", 2228224, 133693440, 20_000_000},
	{"5.0", 8912896, 267386880, 25_000_000},
	{"5.1", 8912896, 534773760, 40_000_000},
	{"5.2", 8912896, 1069547520, 60_000_000},
	{"6.0", 35651584, 1069547520, 60_000_000},
	{"6.1", 35651584, 2139095040, 120_000_000},
	{"6.2", 35651584, 4278190080, 240_000_000},
}

// videoBitrate is a rendition's bitrate in bit/s, by its height and rate.
func videoBitrate(height, fps int) int64 {
	switch {
	case height >= 2160:
		return 35_000_000
	case height >= 1080 && fps >= 100:
		return 18_000_000
	case height >= 1080:
		return 12_000_000
	case height >= 720 && fps >= 60:
		return 8_000_000
	case height >= 720 && fps <= 20:
		return 2_000_000
	case height >= 720:
		return 5_000_000
	}
	return 3_000_000
}

// videoLevel is the lowest level of codec that covers width×height at fps and its bitrate.
// Levels below 3.0 are never used, as in the catalog. An fps no level covers is refused.
func videoLevel(codec string, width, height, fps int) (string, error) {
	w, h := int64(width), int64(height)
	var levels []codecLevel
	switch codec {
	case media.CodecH264:
		levels = h264Levels
		w, h = (w+15)/16, (h+15)/16 // in macroblocks
	case media.CodecH265:
		levels = h265Levels
	default:
		return "", fmt.Errorf("no rendition codec %q", codec)
	}
	picture := w * h
	rate := picture * int64(fps)
	bitrate := videoBitrate(height, fps)
	side := max(w, h)
	for _, level := range levels {
		// Both specs also bound each side: at most sqrt(8 × the largest picture), which is
		// what catches very wide or very tall pictures.
		if picture <= level.maxPicture && rate <= level.maxRate && side*side <= 8*level.maxPicture && bitrate <= level.maxBitrate {
			return level.name, nil
		}
	}
	top := levels[len(levels)-1].name
	return "", newError(http.StatusBadRequest, CodeFPSNotSupported,
		"%d×%d at %d fps is beyond the highest %s level (%s).", width, height, fps, codecLabel(codec), top)
}

func codecLabel(codec string) string {
	switch codec {
	case media.CodecH264:
		return "H.264"
	case media.CodecH265:
		return "H.265"
	case media.CodecMJPEG:
		return "MJPEG"
	}
	return codec
}

// encodeArgs are ffmpeg's arguments for a constant-rate rendition of source at fps, written to
// output: a keyframe every second, no B-frames, closed GOPs, the parameter sets with every
// keyframe, H.264 baseline or H.265 main at the level videoLevel gives, progress on stdout.
func encodeArgs(source, output, codec string, width, height, fps int) ([]string, error) {
	level, err := videoLevel(codec, width, height, fps)
	if err != nil {
		return nil, err
	}
	rate := fmt.Sprint(videoBitrate(height, fps))
	common := []string{
		"-pix_fmt", "yuv420p",
		"-g", fmt.Sprint(fps), "-keyint_min", fmt.Sprint(fps),
		"-bf", "0", "-flags", "+cgop",
		"-b:v", rate, "-maxrate", rate, "-bufsize", rate,
	}
	var codecArgs []string
	if codec == media.CodecH264 {
		// H.264's timing counts fields, so its tick rate is twice the frame rate.
		codecArgs = append([]string{
			"-c:v", "libx264", "-preset", "medium", "-profile:v", "baseline", "-level:v", level,
			"-refs", "1", "-sc_threshold", "0",
		}, common...)
		codecArgs = append(codecArgs,
			"-x264-params", "repeat-headers=1:force-cfr=1:open-gop=0",
			"-tag:v", "avc1",
			"-bsf:v", fmt.Sprintf("h264_metadata=aud=remove,dump_extra=freq=keyframe,h264_metadata=aud=insert:tick_rate=%d/1", fps*2),
		)
	} else {
		codecArgs = append([]string{
			"-c:v", "libx265", "-preset", "medium", "-profile:v", "main", "-level:v", level,
		}, common...)
		codecArgs = append(codecArgs,
			"-tag:v", "hvc1",
			"-x265-params", fmt.Sprintf("level-idc=%s:high-tier=0:keyint=%d:min-keyint=%d:scenecut=0:bframes=0:ref=1:open-gop=0:log-level=error:repeat-headers=1", level, fps, fps),
			"-bsf:v", fmt.Sprintf("hevc_metadata=aud=remove,hevc_metadata=aud=insert:tick_rate=%d/1", fps),
		)
	}
	args := []string{
		"-y", "-nostdin", "-hide_banner", "-loglevel", "error",
		"-i", "file:" + source,
		"-map", "0:v:0", "-an",
		"-vf", fmt.Sprintf("setpts=PTS-STARTPTS,fps=%d", fps),
		"-fps_mode", "cfr",
	}
	args = append(args, codecArgs...)
	return append(args,
		"-movflags", "+faststart",
		"-avoid_negative_ts", "make_zero",
		"-progress", "pipe:1", "-nostats",
		"-f", "mp4", "file:"+output,
	), nil
}
