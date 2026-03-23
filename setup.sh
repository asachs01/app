#!/usr/bin/env bash
set -eo pipefail

# Disclaude Setup Script
# Run on any Mac/Linux box with Node.js 18+, tmux, and Claude Code CLI installed.
# Creates a Disclaude instance and optionally installs it as a persistent service.

INSTALL_DIR="${DISCLAUDE_DIR:-$HOME/disclaude}"
REPO="https://github.com/disclaude/app"

echo "🤖 Disclaude Setup"
echo "=================="
echo ""

# --- Prerequisites check ---
missing=()
command -v node >/dev/null 2>&1 || missing+=("node")
command -v tmux >/dev/null 2>&1 || missing+=("tmux")
command -v claude >/dev/null 2>&1 || missing+=("claude")

if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Missing prerequisites: ${missing[*]}"
  echo "   Install them first, then re-run this script."
  exit 1
fi

echo "✅ Prerequisites: node $(node --version), tmux, claude"
echo ""

# --- Clone or update ---
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📦 Updating existing install at $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  echo "📦 Cloning Disclaude to $INSTALL_DIR..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

npm install --production 2>&1 | tail -1
echo ""

# --- Configure .env ---
if [ -f .env ] && [ -s .env ]; then
  echo "⚙️  Existing .env found. Edit manually if needed: $INSTALL_DIR/.env"
else
  echo "⚙️  Let's configure your .env"
  echo ""
  echo "You'll need these from the Discord Developer Portal:"
  echo "  1. Bot Token (Bot tab → Reset Token)"
  echo "  2. Client ID (OAuth2 tab)"
  echo "  3. Guild/Server ID (right-click server → Copy Server ID)"
  echo "  4. Your Discord User ID (right-click yourself → Copy User ID)"
  echo ""

  read -rp "Discord Bot Token: " BOT_TOKEN
  read -rp "Discord Client ID: " CLIENT_ID
  read -rp "Discord Guild ID: " GUILD_ID
  read -rp "Allowed User IDs (comma-separated): " ALLOWED_USERS
  read -rp "Default working directory [$HOME]: " DEFAULT_DIR
  DEFAULT_DIR="${DEFAULT_DIR:-$HOME}"

  cat > .env <<EOF
DISCORD_TOKEN=${BOT_TOKEN}
DISCORD_CLIENT_ID=${CLIENT_ID}
DISCORD_GUILD_ID=${GUILD_ID}
ALLOWED_USERS=${ALLOWED_USERS}
DEFAULT_DIRECTORY=${DEFAULT_DIR}
EOF

  echo "✅ .env written"
fi
echo ""

# --- Service setup ---
echo "🔧 Setting up persistent service..."
OS="$(uname -s)"
NODE_PATH="$(which node)"
NPX_PATH="$(which npx)"
TSX_PATH="$(command -v tsx || echo "")"

if [ "$OS" = "Darwin" ]; then
  # macOS: launchd plist
  PLIST_LABEL="com.disclaude.bot"
  PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
  LOG_DIR="$HOME/Library/Logs/disclaude"
  mkdir -p "$LOG_DIR"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NPX_PATH}</string>
        <string>tsx</string>
        <string>src/index.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

  echo "✅ launchd plist written to $PLIST_PATH"
  echo ""
  echo "To start:   launchctl load $PLIST_PATH"
  echo "To stop:    launchctl unload $PLIST_PATH"
  echo "Logs:       $LOG_DIR/"

elif [ "$OS" = "Linux" ]; then
  # Linux: systemd user unit
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT_PATH="$UNIT_DIR/disclaude.service"

  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Disclaude - Claude Code in Discord
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NPX_PATH} tsx src/index.ts
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  echo "✅ systemd unit written to $UNIT_PATH"
  echo ""
  echo "To start:   systemctl --user start disclaude"
  echo "To enable:  systemctl --user enable disclaude"
  echo "To logs:    journalctl --user -u disclaude -f"

else
  echo "⚠️  Unknown OS ($OS). You'll need to set up a service manually."
  echo "   Run: cd $INSTALL_DIR && npm start"
fi

echo ""
echo "🎉 Done! Create a Discord app for this host if you haven't already."
echo "   Each host needs its own Discord bot application."
