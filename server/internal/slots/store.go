package slots

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Desired is what the user asked of one slot: the only slot state Insight keeps. Everything
// else a slot shows (live, failed, who reads it) is derived from the world.
type Desired struct {
	Kind Kind
	// File is the library path a file slot streams.
	File string
	// FPS is the slot's output rate: a file slot's, 0 for the file's own; a webcam slot's, one
	// of webcamRates, which names the path its browser publishes to (camName).
	FPS int
	// Run says the user pressed Start (and has not pressed Stop since). It is never saved:
	// after a restart nothing starts by itself.
	Run bool
	// Pull is a pull slot's camera, without its credentials.
	Pull *PullTarget
}

// PullTarget is a camera URL as Insight may keep and show it.
type PullTarget struct {
	// Scheme is "rtsp" or "rtsps".
	Scheme string `json:"scheme"`
	// Host is the camera's host and port ("10.0.0.5:554"), the port always present.
	Host string `json:"host"`
	// Path is the URL's path and query, every query value masked ("/live?token=***").
	Path string `json:"path"`
	// URL is the whole URL when it holds no secret (no user, password or query); "" when it
	// does, since a secret is never written. Such a pull needs its URL again after a restart.
	URL string `json:"url,omitempty"`
}

// storeVersion is the format of the saved file.
const storeVersion = 1

type storedFile struct {
	Version int          `json:"version"`
	Slots   []storedSlot `json:"slots"`
}

type storedSlot struct {
	N    int         `json:"n"`
	Kind Kind        `json:"kind"`
	File string      `json:"file,omitempty"`
	FPS  int         `json:"fps,omitempty"`
	Pull *PullTarget `json:"pull,omitempty"`
}

// Store holds the slots' desired state and saves it to one file. It has one owner, the
// Manager, whose lock guards the slots; only the write to disk has a lock of its own, so that
// the owner never holds its lock across file I/O.
type Store struct {
	path  string
	slots [Count]Desired // guarded by the owner's lock

	version uint64 // guarded by the owner's lock; counts the changes

	writeMu sync.Mutex
	written uint64 // the version on disk; guarded by writeMu
}

// LoadStore reads the store saved at path. A missing file is an empty store. A file that
// cannot be read or understood also gives an empty store, with an error that says why, so
// that Insight still starts; the file is replaced at the next change. Nothing a slot had is
// running after a load: every slot comes back stopped.
func LoadStore(path string) (*Store, error) {
	s := &Store{path: path}
	for n := range s.slots {
		s.slots[n].Kind = KindNone
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, fmt.Errorf("reading the sources: %w", err)
	}
	var file storedFile
	if err := json.Unmarshal(content, &file); err != nil {
		return s, fmt.Errorf("%s is damaged, so every source starts empty: %w", path, err)
	}
	if file.Version != storeVersion {
		return s, fmt.Errorf("%s has format %d, not %d, so every source starts empty", path, file.Version, storeVersion)
	}
	var problems []error
	for _, saved := range file.Slots {
		d, err := saved.desired()
		if err != nil {
			problems = append(problems, err)
			continue
		}
		s.slots[saved.N-1] = d
	}
	return s, errors.Join(problems...)
}

// desired checks one saved slot; a slot that cannot be one is left empty.
func (saved storedSlot) desired() (Desired, error) {
	if saved.N < 1 || saved.N > Count {
		return Desired{}, fmt.Errorf("a saved source %d, which does not exist, was left out", saved.N)
	}
	d := Desired{Kind: saved.Kind}
	switch saved.Kind {
	case KindNone:
	case KindWebcam:
		// A store from before there were two rates saves none: the one rate there was.
		rate, ok := webcamRate(saved.FPS)
		if !ok {
			return Desired{}, fmt.Errorf("saved source %d's webcam rate %d is not one Insight streams at, so it was left out", saved.N, saved.FPS)
		}
		d.FPS = rate
	case KindFile:
		if saved.File == "" || saved.FPS < 0 {
			return Desired{}, fmt.Errorf("saved source %d's file was left out", saved.N)
		}
		d.File, d.FPS = saved.File, saved.FPS
	case KindPull:
		if saved.Pull == nil || saved.Pull.Host == "" {
			return Desired{}, fmt.Errorf("saved source %d's camera was left out", saved.N)
		}
		pull := *saved.Pull
		d.Pull = &pull
	default:
		return Desired{}, fmt.Errorf("saved source %d has an unknown kind %q", saved.N, saved.Kind)
	}
	return d, nil
}

// get returns slot n's desired state (n from 1); the owner holds its lock.
func (s *Store) get(n int) Desired { return s.slots[n-1] }

// set replaces slot n's desired state; the owner holds its lock and calls save after.
func (s *Store) set(n int, d Desired) {
	if d.Kind == "" {
		d.Kind = KindNone
	}
	s.slots[n-1] = d
	s.version++
}

// setRun changes slot n's Run alone, which is never saved and so needs no save.
func (s *Store) setRun(n int, run bool) { s.slots[n-1].Run = run }

// encode returns the current version and its file content; the owner holds its lock.
func (s *Store) encode() (uint64, []byte) {
	file := storedFile{Version: storeVersion, Slots: []storedSlot{}}
	for i, d := range s.slots {
		if d.Kind == KindNone {
			continue
		}
		saved := storedSlot{N: i + 1, Kind: d.Kind, File: d.File, FPS: d.FPS}
		if d.Pull != nil {
			pull := *d.Pull
			saved.Pull = &pull
		}
		file.Slots = append(file.Slots, saved)
	}
	content, _ := json.MarshalIndent(file, "", "  ") // plain structs: cannot fail
	return s.version, append(content, '\n')
}

// write saves content as version, unless a later version is on disk already (two changes
// whose writes overtook each other). It replaces the file whole: a crash leaves the old file
// or the new one, never a part. Called without the owner's lock.
func (s *Store) write(version uint64, content []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if version <= s.written {
		return nil
	}
	if err := writeAtomically(s.path, content); err != nil {
		return fmt.Errorf("saving the sources: %w", err)
	}
	s.written = version
	return nil
}

// writeAtomically writes content to a temporary file beside path, flushes it to the disk and
// renames it over path.
func writeAtomically(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(content)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name()) // the temporary file this call made
		return err
	}
	return nil
}
