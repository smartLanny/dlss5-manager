# 组件清单 v2（0.2 候选）

与原始 `.addon64` 和 v1 包并存。ZIP 外层仍为 `manifest.json` 的 `{ "manifest": ... }`，Ed25519 签名始终覆盖原始 manifest 的规范 JSON，不覆盖归一化视图。归一化仅为复用既有事务引擎，不授予额外写入权限。

## 字段

必填：`schemaVersion: 2`、`componentId: nr-before-sr`、`displayName`、`version`、`channel`（stable/beta/local）、`managerMinVersion`、`architectures: [x64]`、`supportedApis`、`files`、`dependencies`、`conflicts`、`rollbackProtocol: manager-journal-v1`、`source`、`license`。

可选 `managerMaxVersion` 为包含端点的最大版本。版本采用 2–4 段数字及可选预发布标记，兼容 `0.3.3.4` / `0.3.8beta`；不支持通用 semver 表达式、通配符或任意范围语言。未知格式拒绝，不猜测。

每个文件须有 `path`、`role`、`sha256`、`size`，严格对照内容校验。当前写入仍只允许一个 addon 和可选的 NR runtime；不能将 ReShade、系统 DLL 或任意资源伪装成已授权组件。配置资源、多组件独立安装和联网更新源尚未开放。

依赖每项含 `componentId`（reshade/nr-runtime）、可选 `minVersion` / `maxVersion`、必填 `capabilities` 数组（允许 addon-support 或空数组）。须由扫描器或审定目录提供真实匹配证据；清单本身、产品名和人工勾选不产生证据。审定目录当前为空，无法证明的依赖会阻止安装。空依赖数组表示未声明附加约束，不代表已经证明运行环境兼容。

冲突每项选择 `fileName` 或 `componentId` 之一。识别到匹配即阻止；未知组件身份不被忽略。依赖、冲突和版本限制在预览及执行前都核验。

`source` 包含 kind（local/official）和可选无凭据 HTTPS URL；`license` 包含 name、redistribution（not-declared/allowed/not-allowed）和可选 URL。这些是声明，不是官方信任或再分发授权的独立证明。

## 打包

原脚本继续生成 v1 包。使用 `--component-manifest <明确选择的本地JSON>` 可生成 v2 包，其他参数 `--addon --version --api --out` 不变。清单文件的版本、API、文件路径、哈希和大小必须与实际输入完全匹配，工具不会替作者悄悄修正错误。不要将真实 addon 或签名凭据提交到公开仓库。

## 安装与恢复

同版本同哈希只校验，不新增事务、不复制文件、不重建 Original Backup。较旧版本需要单独降级确认；同版本不同字节显示文件变化。没有提供的已管理 runtime 明确显示“保留”，不静默删除。

原始备份与最近已提交事务先核验，任何漂移或同目录其他活动归属均阻止更新。失败及卸载复用原恢复协议。

## 防止旧管理器忽略约束

首次导入 v2 包会弹出格式升级确认，默认取消；确认后保存旧 state 的本地元数据快照，再将 state schema 设为 2。0.1 的严格版本检查将拒绝打开，不能把 v2 的安装视图当成无约束 v1 包执行。原始游戏文件备份不改变。这个存储升级不等于对游戏写入，也不是自动提供旧版降级迁移工具。
