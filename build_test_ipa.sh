#!/usr/bin/env bash
# 在 macOS 上生成一个最小的、部署目标 iOS 13.0 的【未签名】IPA。
# 用途：验证 iPadOS 13.5.1 的安装链路（爱思助手 Apple ID 免费签 / 越狱 AppSync 直装）。
# 不依赖 Flutter、CocoaPods 或 Xcode 工程文件，只用 clang 编译一个 UIKit App，几秒完成。
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
if [[ -n "$MINOS" && "$MINOS" != "13.0" ]]; then
  echo "::error::Mach-O minos 是 $MINOS，不是 13.0，iPadOS 13.5.1 可能装不上。" >&2
  exit 1
fi
PLIST_MIN=$(/usr/libexec/PlistBuddy -c "Print :MinimumOSVersion" Info.plist)
echo "Info.plist MinimumOSVersion = $PLIST_MIN"
if [[ "$PLIST_MIN" != "13.0" ]]; then
  echo "::error::Info.plist 的 MinimumOSVersion 是 $PLIST_MIN，不是 13.0。" >&2
  exit 1
fi

echo "==> [4/4] 组装 .app 并打包 IPA（不签名）"
rm -rf Payload ipados13-test.ipa
mkdir -p Payload/TestApp.app
cp TestApp Payload/TestApp.app/
cp Info.plist Payload/TestApp.app/
printf 'APPL????' > Payload/TestApp.app/PkgInfo
zip -qry ipados13-test.ipa Payload
rm -rf Payload TestApp

echo "==> 完成"
ls -lh ipados13-test.ipa
echo "输出: $(pwd)/ipados13-test.ipa"
echo "下一步：爱思助手「IPA 签名」用 Apple ID 签名，或越狱设备装 AppSync 后直接安装。"
