package slots

import (
	"context"
	"fmt"
	"log/slog"
)

// FileUser is what the media library asks of the slots when it deletes or replaces files
// (internal/library declares the same interface). Manager implements it.
type FileUser interface {
	// SlotsUsing returns the file slots assigned the library file path, in their order.
	SlotsUsing(path string) []int
	// Restart starts the given slots' publishers again, so a slot that streamed a file that
	// was replaced streams the new one (encoding its rendition again when it has one). A slot
	// that is not running is left as it is. It returns one error per slot, in order, nil
	// where the slot was restarted or had nothing to restart.
	Restart(ctx context.Context, slots []int) []error
	// Unassign clears the given slots, as Clear does.
	Unassign(slots []int)
}

var _ FileUser = (*Manager)(nil)

// SlotsUsing implements FileUser.
func (m *Manager) SlotsUsing(path string) []int {
	m.mu.Lock()
	defer m.mu.Unlock()
	var using []int
	for n := 1; n <= Count; n++ {
		if d := m.store.get(n); d.Kind == KindFile && d.File == path {
			using = append(using, n)
		}
	}
	return using
}

// Restart implements FileUser. It stops each slot's publisher, then reconciles the slot at once,
// so the publisher that starts opens the file as it is now. A replaced file is a new version
// with renditions of its own, so the reconcile also lets go of an encode of the old one.
func (m *Manager) Restart(ctx context.Context, slots []int) []error {
	errs := make([]error, len(slots))
	for i, n := range slots {
		if err := checkSlot(n); err != nil {
			errs[i] = err
			continue
		}
		if err := m.restart(ctx, n); err != nil {
			errs[i] = fmt.Errorf("src%d: %w", n, err)
		}
	}
	// The replaced file's old renditions are of no use now that its slots let go of them.
	if err := m.PruneRenditions(); err != nil {
		slog.Warn("removing the renditions of a replaced file", "error", err)
	}
	return errs
}

func (m *Manager) restart(ctx context.Context, n int) error {
	rt := m.rt[n-1]
	rt.reconcileMu.Lock()
	m.mu.Lock()
	proc := rt.proc
	running := m.store.get(n).Run
	rt.blocked = ""
	m.mu.Unlock()
	var err error
	if proc != nil {
		err = proc.Stop(ctx)
		if err == nil {
			m.mu.Lock()
			if rt.proc == proc {
				rt.proc, rt.procInput, rt.procActive = nil, "", ""
			}
			m.mu.Unlock()
		}
	}
	rt.reconcileMu.Unlock()
	if err != nil {
		return fmt.Errorf("its stream did not stop: %w", err)
	}
	if !running {
		return nil
	}
	m.reconcile(n)
	m.mu.Lock()
	blocked := rt.blocked
	m.mu.Unlock()
	if blocked != "" {
		return fmt.Errorf("%s", blocked)
	}
	return nil
}

// Unassign implements FileUser.
func (m *Manager) Unassign(slots []int) {
	for _, n := range slots {
		_ = m.Clear(n) // a number that names no slot has nothing to clear
	}
}
