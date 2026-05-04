# VHS tape: a 30-second tour of the yoke CLI.
# Run with: vhs scripts/e2e/capture/setup.tape
# Output:   docs/img/yoke-cli-tour.gif
#
# This script runs in an ephemeral /tmp/ git repo so it never touches the
# host project. Each command is interactive; outputs are real, not staged.

Output docs/img/yoke-cli-tour.gif

Set Shell zsh
Set FontSize 14
Set Width 1100
Set Height 640
Set Padding 16
Set Theme "Dracula"
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0

Hide
Type "cd $(mktemp -d /tmp/yoke-tour-XXXXXX) && git init -q -b main && git config user.email v@v && git config user.name v && git commit -q --allow-empty -m b && clear"
Enter
Sleep 600ms
Show

Type "yoke --version"
Enter
Sleep 1500ms

Type "yoke --help | head -30"
Enter
Sleep 3500ms

Type "yoke init --template one-shot"
Enter
Sleep 3500ms

Type "ls .yoke/templates"
Enter
Sleep 1500ms

Type "yoke doctor"
Enter
Sleep 4500ms

Sleep 1500ms
