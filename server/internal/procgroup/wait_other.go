//go:build !linux

package procgroup

// canWaitUnreaped is false here (macOS has no waitid with WNOWAIT in x/sys), so Group.Wait reaps
// first and kills the rest of the group right after. A pid reused in that moment, by a process
// that leads a group of its own, is the one case it could reach.
const canWaitUnreaped = false

var waitExited = func(int) bool { return false }
