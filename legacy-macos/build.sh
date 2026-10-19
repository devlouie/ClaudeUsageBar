#!/bin/bash
set -e

APP_NAME="ClaudeUsageBar"
BUILD_DIR=".build/release"
APP_BUNDLE="$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
ENTITLEMENTS="Sources/ClaudeUsageBar/ClaudeUsageBar.entitlements"
SIGN_IDENTITY="${CLAUDEUSAGEBAR_SIGN_IDENTITY:-ClaudeUsageBar Developer}"

echo "Building $APP_NAME..."
swift build -c release 2>&1

echo "Creating app bundle..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS"

cp "$BUILD_DIR/$APP_NAME" "$MACOS/$APP_NAME"
cp "Sources/ClaudeUsageBar/Info.plist" "$CONTENTS/Info.plist"

echo "Signing..."
if security find-identity -v -p codesigning | grep -q "$SIGN_IDENTITY"; then
    codesign --force --options runtime \
        --entitlements "$ENTITLEMENTS" \
        --identifier "com.local.ClaudeUsageBar" \
        --sign "$SIGN_IDENTITY" \
        "$APP_BUNDLE"
    echo "Signed with: $SIGN_IDENTITY"
    echo "Designated requirement:"
    codesign -dr - "$APP_BUNDLE" 2>&1 | sed 's/^/  /'
else
    echo "WARNING: code-signing identity '$SIGN_IDENTITY' not found."
    echo "         Falling back to ad-hoc signing; macOS Keychain will prompt on every launch."
    echo "         See README.md for one-time cert creation instructions."
    codesign --force --sign - "$APP_BUNDLE"
fi

echo ""
echo "Done! App bundle created at: $(pwd)/$APP_BUNDLE"
echo ""
echo "To run:  open $APP_BUNDLE"
echo "To install: cp -r $APP_BUNDLE /Applications/"
