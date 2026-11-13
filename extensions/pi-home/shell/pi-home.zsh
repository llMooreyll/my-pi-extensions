# pi-home zsh integration (PLAN.md §3).
#
#   source /path/to/extensions/pi-home/shell/pi-home.zsh     # in ~/.zshrc
#
# Bare `pi` in an interactive terminal opens pi-home; any arguments go straight to pi, so scripts,
# subagents (`pi --session …`) and pi-remote (`pi --approve …`) are unaffected.
# Bypass once with `command pi`, or for a whole shell with `export PI_HOME_DISABLE=1`.

typeset -g PI_HOME_ROOT=${${(%):-%x}:A:h:h}

pi-home() {
	node "$PI_HOME_ROOT/src/main.ts" "$@"
}

# Show pi-home, run the chosen pi command, come back (config `returnToHome`), repeat.
pi-home-loop() {
	emulate -L zsh
	local launch="${XDG_RUNTIME_DIR:-/tmp}/pi-home.$$.launch"
	local -a spec
	while true; do
		rm -f -- "$launch"
		pi-home --launch-file "$launch" || break
		[[ -s $launch ]] || break
		# NUL-separated: working directory, then pi arguments.
		spec=("${(@0)$(<$launch)}")
		rm -f -- "$launch"
		( builtin cd -- "${spec[1]}" && command pi "${(@)spec[2,-1]}" )
		[[ "$(pi-home --config returnToHome)" == true ]] || break
	done
}

pi() {
	if (( $# == 0 )) && [[ -t 0 && -t 1 && -z ${PI_HOME_DISABLE:-} ]]; then
		pi-home-loop
	else
		command pi "$@"
	fi
}
