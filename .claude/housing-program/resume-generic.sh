#!/bin/zsh
# usage: resume-generic.sh <track> <promptfile>
t=$1; pf=$2
cd ~/projects/.worktrees/shorted-hw-$t || exit 1
nohup node "/Users/benebsworth/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs" task --background --write --model gpt-5.6-sol --effort high --prompt-file "$pf" > /tmp/$t-resume.log 2>&1 &
sleep 20
tail -2 /tmp/$t-resume.log
