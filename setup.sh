#!/usr/bin/env bash
set -e

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║      Whappi - Setup Wizard       ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js was not found. Install Node.js 20+ and try again."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js $NODE_VERSION found, but 20+ is required."
  exit 1
fi
echo "✓ Node.js $(node -v) found"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm ci --silent
echo "✓ Dependencies installed"

# Build
echo ""
echo "🔨 Compiling TypeScript..."
npm run build --silent
echo "✓ Build succeeded"

# Generate .env
if [ -f .env ]; then
  echo ""
  echo "⚠️  .env already exists — will not be overwritten."
else
  echo ""
  echo "🔑 Creating .env..."

  API_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  read -p "Admin username [admin]: " ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}

  while true; do
    read -sp "Admin password: " ADMIN_PASSWORD
    echo ""
    if [ ${#ADMIN_PASSWORD} -lt 6 ]; then
      echo "   Password must be at least 6 characters."
    else
      break
    fi
  done

  read -p "Server port [3100]: " PORT
  PORT=${PORT:-3100}

  cat > .env << EOF
PORT=${PORT}
INTERNAL_API_KEY=${API_KEY}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
NODE_ENV=production
EOF

  echo "✓ .env created"
  echo ""
  echo "   Your API key: ${API_KEY}"
  echo "   Keep this safe — you will need it to call the API."
fi

echo ""
echo "══════════════════════════════════════"
echo ""
echo "  ✅ Whappi is ready!"
echo ""
echo "  Start:            npm start"
echo "  With PM2:         pm2 start ecosystem.config.js"
echo "  Dashboard:        http://localhost:${PORT:-3100}/admin"
echo "  API docs:         http://localhost:${PORT:-3100}/admin/help"
echo ""
echo "  On first start: scan the QR code in the terminal"
echo "  or on the dashboard to connect WhatsApp."
echo ""
echo "══════════════════════════════════════"
echo ""
