//go:build !windows

package fetch

import "syscall"

// detachedProcAttr starts the daemon in its own session so it survives the terminal closing
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
