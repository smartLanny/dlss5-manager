# 第三方与参考来源

本次按公开行为与文件格式独立实现游戏发现、海报缓存及安装编排；没有复制 NR before SR 私有实现，也没有把第三方安装器源码整体并入管理器。

## ReShade

作者 crosire。官网 https://reshade.me/，源代码 https://github.com/crosire/reshade 。本管理器从官网下载固定版本 6.8.0 的 full Add-on 安装文件，验证整包及提取 DLL 的固定 SHA-256 后缓存到玩家本机，不执行该下载的安装程序。公共管理器发行包不再分发 ReShade 二进制或 shader 文件。

实际提取行为由 .github/workflows/verify-reshade.yml 和 scripts/test-official-runtime.cjs 验证。哈希用于内容完整性，不冒充发布者数字签名，也不代表 NR 游戏兼容性已经验证。

## 产品和实现参考

- DLSS5-Swapper：https://github.com/rakanki911/DLSS5-Swapper ，MIT；参考游戏发现的 import/delay-load/engine-DLL 分层、海报及单游戏操作设计。
- RHI：https://github.com/RankFTW/RHI ，参考从官方网站准备、提取和缓存 ReShade 的流程；本版未复制其 GPL 源代码。
- Microsoft PE/COFF 格式：https://learn.microsoft.com/en-us/windows/win32/debug/pe-format 。
- Electron 安全建议：https://www.electronjs.org/docs/latest/tutorial/security 。

## 游戏海报

图片优先来自本机 Steam 缓存，其次按 Steam App ID 从 Steam 图片 CDN 读取。图片不随源代码发布，也不用于确认游戏运行兼容。用户可以关闭联网图片或选择本地海报。游戏名称、图片与商标属于各自权利人。发行页附带的 UI 演示图明确标注为示例库，不是实机兼容性证明。

Electron/Chromium 的第三方许可证继续随程序分发，不受本项目原创代码许可限制影响。
