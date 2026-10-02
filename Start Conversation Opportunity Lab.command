#!/bin/zsh

set -e

LAB_PROJECT_DIR="${0:A:h}"
cd "$LAB_PROJECT_DIR"

echo "Starting Conversation Opportunity Lab..."
echo "Keep this Terminal window open while using the app."
echo "App: http://127.0.0.1:5173/transcript.html"
echo

exec npm run transcript:dev
