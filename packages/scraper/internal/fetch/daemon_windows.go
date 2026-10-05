//go:build windows

package fetch

import "syscall"

const (
	createNewProcessGroup = 0x00000200
	detachedProcess       = 0x00000008
)

// detachedProcAttr starts the daemon with no console and outside the caller's process group,
// so it survives the terminal closing and ignores the caller's Ctrl+C
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNewProcessGroup | detachedProcess,
	}
}
