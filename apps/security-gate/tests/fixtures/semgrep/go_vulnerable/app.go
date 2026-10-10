package app
import "os/exec"
func run(command string) { exec.Command(command).Run() }
