#!/usr/bin/env bash
# 在 macOS 上生成最小的、部署目标 iOS 13.0 的测试 IPA（两个版本）。
#   ipados13-test-adhoc.ipa    : ad-hoc 签名版，推荐，兼容绝大多数安装器 / 越狱环境
#   ipados13-test-unsigned.ipa : 完全未签名，仅供 AppSync Unified 直装
# 不依赖 Flutter、CocoaPods 或 Xcode 工程文件，只用 clang 编译一个 UIKit App。
# 需要 Xcode 16 或更早（Xcode 26 的部署目标下限是 iOS 15）。
set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/4] 定位 iOS SDK"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
echo "SDK: $SDK"

echo "==> [2/4] clang 编译 main.m (arm64, minos 13.0)"
xcrun --sdk iphoneos clang \
  -arch arm64 \
  -target arm64-apple-ios13.0 \
  -isysroot "$SDK" \
  -fobjc-arc \
  -framework UIKit -framework Foundation \
  -o TestApp main.m
file TestApp

echo "==> [3/4] 校验最低系统版本"
# 真正的 ABI 下限在 Mach-O 的 LC_BUILD_VERSION / minos，比 Info.plist 更硬。
MINOS=$(otool -l TestApp | awk '/LC_BUILD_VERSION/{f=1} f && /minos/{print $2; exit}')
echo "Mach-O minos = ${MINOS:-未读到}"
if [[ -z "$MINOS" ]]; then
  echo "::error::无法从 Mach-O 读取 LC_BUILD_VERSION/minos，编译产物异常。" >&2
  exit 1
fi
if [[ "$MINOS" != "13.0" ]]; then
  echo "::error::Mach-O minos 是 $MINOS，不是 13.0，iPadOS 13.5.1 可能装不上。" >&2
  exit 1
fi
PLIST_MIN=$(/usr/libexec/PlistBuddy -c "Print :MinimumOSVersion" Info.plist)
echo "Info.plist MinimumOSVersion = $PLIST_MIN"
if [[ "$PLIST_MIN" != "13.0" ]]; then
  echo "::error::Info.plist 的 MinimumOSVersion 是 $PLIST_MIN，不是 13.0。" >&2
  exit 1
fi

echo "==> [4/4] 组装 .app，补齐标准字段，产出两个 IPA"
rm -rf Payload ipados13-test-*.ipa
mkdir -p Payload/TestApp.app
cp TestApp Payload/TestApp.app/
cp Info.plist Payload/TestApp.app/
printf 'APPL????' > Payload/TestApp.app/PkgInfo

PLIST=Payload/TestApp.app/Info.plist
PB=/usr/libexec/PlistBuddy
# 手工拼的 .app 缺 Xcode 注入的字段，部分安装器会据此误判兼容性。
$PB -c "Add :CFBundleSignature string ????" "$PLIST" 2>/dev/null || true
$PB -c "Add :DTPlatformName string iphoneos" "$PLIST" 2>/dev/null || true
$PB -c "Add :DTPlatformVersion string 13.0" "$PLIST" 2>/dev/null || true
$PB -c "Add :DTSDKName string iphoneos13.0" "$PLIST" 2>/dev/null || true

# 版本 A：完全未签名（AppSync Unified 直装用）
zip -qry ipados13-test-unsigned.ipa Payload

# 版本 B：ad-hoc 签名，补上 LC_CODE_SIGNATURE / _CodeSignature。
# 上一版完全无签名，iOS 13 的 installd 会直接拒绝；这是最可能的安装失败原因。
codesign -s - --force --timestamp=none Payload/TestApp.app
echo "--- codesign 结果 ---"
codesign -dv --verbose=2 Payload/TestApp.app 2>&1 | head -12 || true
if ! otool -l Payload/TestApp.app/TestApp | grep -q LC_CODE_SIGNATURE; then
  echo "::error::ad-hoc 签名未生效，Mach-O 仍缺少 LC_CODE_SIGNATURE。" >&2
  exit 1
fi
# 签名后再次确认 minos 没被改坏
MINOS2=$(otool -l Payload/TestApp.app/TestApp | awk '/LC_BUILD_VERSION/{f=1} f && /minos/{print $2; exit}')
echo "签名后 Mach-O minos = $MINOS2"
[[ "$MINOS2" == "13.0" ]] || { echo "::error::签名后 minos 异常"; exit 1; }

zip -qry ipados13-test-adhoc.ipa Payload
rm -rf Payload TestApp

echo "==> 完成"
ls -lh ipados13-test-*.ipa
echo "推荐先用: $(pwd)/ipados13-test-adhoc.ipa"
echo "非越狱设备仍需爱思助手「IPA 签名」用 Apple ID 重签并安装描述文件；"
echo "越狱设备需 AppSync Unified 才能直装未签名 / ad-hoc 包。"
