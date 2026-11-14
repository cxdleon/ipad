#!/usr/bin/env bash
# Dongge Music - build an iPadOS 13 ad-hoc signed IPA on macOS.
#
# Target: iPadOS 13.5.1, jailbroken + AppSync Unified.
# SOP (verified 2026-11-14): ad-hoc signature via `codesign -s -` is REQUIRED.
# A completely unsigned IPA is rejected by iOS 13 installd even on a jailbreak.
# No Xcode project, no CocoaPods, no Flutter - just clang + zip, ~20 seconds.
# Requires Xcode 16 or older (Xcode 26 cannot target iOS 13).
set -euo pipefail
cd "$(dirname "$0")"

APP="DonggeMusic"
IPA="dongge-music-adhoc.ipa"
EXPECT_MIN="${EXPECT_MIN_OS:-13.0}"
PB=/usr/libexec/PlistBuddy

echo "==> [1/6] 定位 iOS SDK"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
echo "SDK: $SDK"
xcrun --sdk iphoneos clang --version | head -2

echo "==> [2/6] clang 编译 main.m (arm64, minos 13.0)"
xcrun --sdk iphoneos clang \
  -arch arm64 \
  -target arm64-apple-ios13.0 \
  -isysroot "$SDK" \
  -fobjc-arc \
  -framework UIKit \
  -framework Foundation \
  -framework WebKit \
  -framework AVFoundation \
  -framework CoreFoundation \
  -o "$APP" main.m
file "$APP"

echo "==> [3/6] 校验最低系统版本 (Mach-O + Info.plist)"
MINOS=$(otool -l "$APP" | awk '/LC_BUILD_VERSION/{f=1} f && /minos/{print $2; exit}')
echo "Mach-O minos = ${MINOS:-未读到}"
if [[ "$MINOS" != "$EXPECT_MIN" ]]; then
  echo "::error::Mach-O minos 是 ${MINOS:-空}，期望 $EXPECT_MIN。" >&2
  exit 1
fi
PLIST_MIN=$($PB -c "Print :MinimumOSVersion" Info.plist)
echo "Info.plist MinimumOSVersion = $PLIST_MIN"
if [[ "$PLIST_MIN" != "$EXPECT_MIN" ]]; then
  echo "::error::Info.plist MinimumOSVersion 是 $PLIST_MIN，期望 $EXPECT_MIN。" >&2
  exit 1
fi
/usr/bin/plutil -lint Info.plist

echo "==> [4/6] 组装 .app（内嵌 WebView 资源）"
rm -rf Payload "$IPA"
mkdir -p "Payload/$APP.app/web"
cp "$APP" "Payload/$APP.app/"
cp Info.plist "Payload/$APP.app/"
printf 'APPL????' > "Payload/$APP.app/PkgInfo"
chmod 0755 "Payload/$APP.app/$APP"
for f in index.html app.js app.css shim.js plugin.js; do
  if [[ ! -f "web/$f" ]]; then
    echo "::error::缺少 web/$f" >&2
    exit 1
  fi
  cp "web/$f" "Payload/$APP.app/web/$f"
done
PLIST="Payload/$APP.app/Info.plist"
$PB -c "Set :CFBundleExecutable $APP" "$PLIST"
$PB -c "Set :MinimumOSVersion $EXPECT_MIN" "$PLIST"
$PB -c "Add :CFBundleSignature string ????" "$PLIST" 2>/dev/null || true
$PB -c "Add :DTSDKName string iphoneos13.0" "$PLIST" 2>/dev/null || true
echo "bundle 文件数: $(find "Payload/$APP.app" -type f | wc -l | tr -d ' ')"

echo "==> [5/6] ad-hoc 伪签名（越狱 + AppSync 直装必需）"
codesign -s - --force --deep --timestamp=none "Payload/$APP.app"
codesign -dv --verbose=2 "Payload/$APP.app" 2>&1 | head -12 || true
if ! otool -l "Payload/$APP.app/$APP" | grep -q LC_CODE_SIGNATURE; then
  echo "::error::ad-hoc 签名未生效，Mach-O 缺少 LC_CODE_SIGNATURE。" >&2
  exit 1
fi
if [[ ! -f "Payload/$APP.app/_CodeSignature/CodeResources" ]]; then
  echo "::error::缺少 _CodeSignature/CodeResources。" >&2
  exit 1
fi
MINOS2=$(otool -l "Payload/$APP.app/$APP" | awk '/LC_BUILD_VERSION/{f=1} f && /minos/{print $2; exit}')
echo "签名后 Mach-O minos = $MINOS2"
if [[ "$MINOS2" != "$EXPECT_MIN" ]]; then
  echo "::error::签名后 minos 异常。" >&2
  exit 1
fi

echo "==> [6/6] 打包并校验 IPA 结构"
zip -qry "$IPA" Payload
python3 - "$IPA" "$APP" <<'PY'
import sys, zipfile
ipa, app = sys.argv[1], sys.argv[2]
base = 'Payload/' + app + '.app/'
required = [
    base + app,
    base + 'Info.plist',
    base + 'PkgInfo',
    base + '_CodeSignature/CodeResources',
    base + 'web/index.html',
    base + 'web/app.js',
    base + 'web/app.css',
    base + 'web/shim.js',
    base + 'web/plugin.js',
]
z = zipfile.ZipFile(ipa)
names = set(z.namelist())
missing = [x for x in required if x not in names]
if missing:
    sys.exit('::error::IPA 缺少文件: ' + ', '.join(missing))
mode = (z.getinfo(base + app).external_attr >> 16) & 0o777
print('可执行文件权限 =', oct(mode))
if not (mode & 0o111):
    sys.exit('::error::主可执行文件没有执行权限')
print('IPA 条目数 =', len(names))
print('IPA 结构校验通过')
PY

rm -rf Payload "$APP"
ls -lh "$IPA"
echo "==> 完成: $(pwd)/$IPA"
echo "安装方式：越狱 + AppSync Unified 下，用爱思助手直接点「安装」即可；"
echo "          无需 Apple ID 签名、无需重签、无 7 天限制。"
