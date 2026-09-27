# Guest NR runtime 目录钉

本目录供管理器识别、发行方本地打包核对使用。文件是 **第三方 guest 包**，**不是 NVIDIA 官方运行库**。哈希相同只证明字节一致，不证明发布者身份、再分发授权或游戏兼容。

机器可读副本：`config/nr-runtimes.json`。当前 `channel: local`，`verification: unverified`，`license.redistribution: not-declared`。**不要在本仓库提交真实 DLL。** 未声明下载地址；后续 OTA 不得臆造 URL。

## 候选

| id | 显卡族 | 角色 | 大小 | SHA-256 | 现行 v1 包 |
| --- | --- | --- | --- | --- | --- |
| `4050` | RTX 40/50 · Kio v1.0.6 | 主钉 / 该族默认 | 165844992 | `a2d16f9fba2b619559427821169918df56fc8e410a6ac87569953598a00b66fa` | 可打包 |
| `2030` | 20/30 系 | 主钉 / 该族默认 | 309671536 | `6dac1b40f0c87af84a8177b18c741e84fb0c914f204c9d87d95916b665ba3af8` | **不可打包**（超过单文件 256 MiB） |
| `4050-prev` | 40/50 系 | 停用，非默认（前主钉） | 165840496 | `24f2d48e83ee636c8efc05056bbed61daf91bc35e490198485929ebd0d824dd2` | 可打包，须显式指定 |
| `4050-candidate` | 40/50 系 | 停用，非默认 | 165840496 | `f95feb54137ea11979f9b4ec4f00afd84b5c98a5624d3388fbf6a87714a39fcc` | 可打包，须显式指定 |

传输钉（只核验来源压缩包，不是安装文件）：

- 4050：`DLSSNR-RTX40-50-Kio-v1.0.6.zip` 大小 119854342，SHA-256 `c3b8fd6a9b2784f9f0325ab8228ea6289dee63245315b43c624ad1a94909f1f6`
- 2030：`nvngx_dlssnr_plainfp16.zip` SHA-256 `21ac9102fd98e147693925f76f773f5390a1003e782a8dfe210c8e737954e3fc`

选择策略是 **显式** `--runtime-id`。`--runtime-id 4050` 核验 Kio v1.0.6。按 GPU 族自动挑选尚未实现。

## 本地 / 后续 OTA 打包

发行方在有权分发的前提下，把本机 runtime 交给现有打包工具，并按目录钉核验：

```sh
npm run pack:addon -- \
  --addon /本地/插件.addon64 \
  --runtime /本地/nvngx_dlssnr.dll \
  --runtime-id 4050 \
  --version 0.4.2beta \
  --api DX12 \
  --out /私下发布/0.4.2beta-4050.dlss5pkg
```

- `--runtime` 仍是唯一文件输入；工具不会扫描其他目录或仓库。
- `--runtime-id` 对照 `config/nr-runtimes.json` 检查文件名、大小和 SHA-256。不匹配则失败。
- 省略 `--runtime-id` 时，若哈希碰巧命中目录钉，工具会打印识别结果，但仍按原契约打包。
- `4050-prev` 与 `4050-candidate` 只有写明对应 `--runtime-id` 才会使用，不会当成 40/50 默认钉。
- **2030 目前不能打进标准 `.dlss5pkg`**：单文件上限 256 MiB，该 DLL 约 295 MiB。目录钉先用于扫描识别；要随包分发需另开契约修订（提高 `MAX_FILE` / 组件清单上限），不要绕过哈希或安全门。

未登记的 runtime 仍可按原 `--runtime` 路径打包（发布者自行保证来源）。公开默认构建继续不捆绑 NR 二进制。
