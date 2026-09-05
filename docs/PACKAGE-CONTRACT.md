# 本地更新包契约 v1

## 群内发布

最简单的方式是继续发 `.addon64` 文件，并提供版本号、图形 API、运行环境要求和 SHA-256。用户选择文件后导入，安装器不会上传文件，也不会修改原始插件内容。

## 标准包

`.dlss5pkg` 是仅含扁平文件的 ZIP。内容为 `manifest.json`、一个 `.addon64` 和可选的 `nvngx_dlssnr.dll`。不支持子目录、链接、额外文件、加密包或分卷包。单文件上限 256 MiB，总上限 512 MiB。

清单外层字段是 `manifest`。内部必填字段如下。

| 字段 | 取值 |
| --- | --- |
| schema | 1 |
| component | nr-before-sr |
| version | 例如 0.4.2beta |
| architecture | x64 |
| apis | 经发布者确认的 API 数组；DX11、DX12、Vulkan、OpenGL 中选择 |
| files | 文件清单数组，每项含 path、role、sha256 |
| files.path | 扁平文件名，不能包含路径 |
| files.role | addon 或 nr-runtime |
| files.sha256 | 真实文件内容的 64 位小写 SHA-256 |

`addon` 必须且只能有一个，扩展名为 `.addon64`。可选 `nr-runtime` 只能名为 `nvngx_dlssnr.dll`。可选 `rightsNotice` 为组件版权说明。

## 离线打包工具

运行 `npm run pack:addon --` 后，添加 `--addon` 输入文件、`--version` 版本、`--api` API、`--out` 输出包四个参数。可选 `--runtime` 提供发布者有权分发的 runtime。工具仅读取明确输入的文件，生成包和相邻 SHA-256 清单，不进行网络发布，不覆盖已有输出文件。真实分发文件不要放进此公开仓库。

## 签名与信任

支持 Ed25519 发布者签名。签名覆盖规范化的 manifest，规则是对象键递归排序、数组顺序不变、标准 JSON 编码且不增加空白。外层 `keyId` 指向管理器预置的公钥，外层 `signature` 为 Base64 签名。

`config/trusted-keys.json` 在 0.1 Beta 中为空，尚未接入正式发布者公钥。工具的签名参数由 `--sign-key` 和 `--key-id` 提供；不要把签名凭据提交到仓库。签名包的公钥未知或验证失败时拒绝导入，不自动降级。

SHA-256 相同只证明文件内容一致，不证明发布者身份。界面分别显示来源未认证、校验值匹配但未签名、发布者签名已验证。

## 恢复

恢复由管理器独立处理，不需要 addon 执行代码。每次记录事务 ID、原文件备份、替换前后哈希。先完成所有备份，再写入。第一次接管前的基线跨更新保留；撤销回到上一状态，卸载回到初始基线。外部改动会阻止自动覆盖。
