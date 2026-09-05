# 装机宅 DLSS5 安装器

**0.2 Beta 开发候选 · Windows x64 · NR before SR 插件的独立管理器**

本分支不覆盖已发布的 `v0.1.0-beta.1`。0.2 的实际改动和验收范围见 [下一版说明](docs/RELEASE-0.2-BETA.md)，是否已发布以 Release 页面为准。

把选游戏、导入 addon、安全检查、备份更新和恢复放进一个中文界面。以后群里发新 addon，不用再手动覆盖游戏目录。

[下载 Beta](https://github.com/smartLanny/dlss5-manager/releases) · [装机宅 B 站主页与教程](https://space.bilibili.com/941799) · [反馈问题](https://github.com/smartLanny/dlss5-manager/issues)

## 先说明白

本项目只负责管理插件，**不包含 NR before SR 源码或真实插件二进制，不会把私下发布的 addon 上传到 GitHub**。三个版本卡片是预置导入入口，不是已经内置插件。首次使用前，需要按官方教程配置对应游戏支持 Add-on 的 ReShade 与所需 NR runtime。

这版适合已确认的 Windows x64 离线单机游戏。不会给在线竞技游戏自动安装，不绕过反作弊，不自动覆盖 `dxgi.dll`、`d3d12.dll` 等代理或系统 DLL。某个 API 可以选择，不代表某个插件版本已经支持；未实测的组合一律显示“待验证”。

## 0.2 本轮新增

同版本、同哈希重复安装改为只校验，不再重复写文件或建立新事务；降级明确确认；同版本但文件不同明确显示。安装归属须与已提交事务一致，同目录不能被两条游戏记录重复接管，更新前再次核验首次原始备份。

新增严格的 [组件清单 v2](docs/COMPONENTS-V2.md)：身份、渠道、管理器版本范围、精确大小、依赖、冲突和恢复协议。旧单 addon 和 v1 包仍可使用。清单里的 official 或 allowed 是发布者声明，不会自动获得信任或覆盖核心 DLL 的权限。

新增“反馈与诊断”：七类问题、只读检查、可预览公开报告、版本化反馈 ZIP 校验、旧 ZIP 附件、本地私有包。复制报告后打开 Manager 公开 Issue 页，由用户自行粘贴并提交；不持有 GitHub token，不自动上传附件。详见 [反馈契约](docs/FEEDBACK-CONTRACT.md)。

ReShade 只增加证据分级和官方获取入口；本版的审定哈希目录为空，绝不把产品名或版本字符串显示成“完整 Add-on 已验证”。**#10 的一体化部署仍未完成**。官网要求不再分发其官方二进制，当前采用官网获取路径，不捆绑下载物。

**元数据升级提示**：仅使用旧包不会改写存储版本；首次导入组件 v2 时，先在本机 `metadata-backups` 保存旧元数据，再升级为存储 schema 2。0.1 无法安全执行 v2 的约束，会拒绝读取该存储。原始游戏备份和事务不移动、不重建；请使用 0.2 恢复，勿在未回滚游戏文件时仅恢复旧元数据。

## 怎么用

1. 下载 `Setup.exe` 安装版，或直接运行 `Portable.exe` 便携版。两者都不需要安装 Node.js。
2. 扫描 Steam，或点击“添加游戏”选择真正运行的 EXE；确认 API 和单机离线类型。
3. 导入装机宅发布的 `.addon64`，选择 `0.3.3.4`、`0.3.8beta`、`0.4.2beta` 或自己填写后续版本。根据发布说明填写 API，建议同时粘贴官方 SHA-256。
4. 点击“检查并预览安装”，核对文件清单。确认后自动备份，再执行替换。出现异常先退出游戏，再去“恢复中心”撤销最近一次操作。

已有旧 addon 时，只对明确选中的目标文件询问是否接管。换版本会复用管理器已经拥有的 addon 文件名，避免新旧 addon 并存。玩家自己后来改过的文件不会被恢复操作强行覆盖。

“卸载并恢复原文件”会恢复第一次接管前的原文件；“撤销这次操作”只撤销最近一次安装、更新或卸载。卸载管理器本身不会删除恢复数据。

## 已接通的功能

| 模块 | Beta 行为 |
| --- | --- |
| 游戏库 | Steam 库发现、选择 Steam 库、手动 EXE、候选 EXE 排序、排除常见启动器、API 人工确认、打开目录、复制路径 |
| 文件检查 | 路径、x86/x64/ARM64、版本、Authenticode 状态、SHA-256、静态依赖、来源线索、管理器归属与风险 |
| 风险门禁 | 在线类型、部分已知在线 Steam ID、EAC/BattlEye/XIGNCODE/ACE 等目录和运行服务线索、进程/文件占用、不完整扫描 |
| 本地更新 | 单 addon、标准 ZIP / `.dlss5pkg`、包清单、CRC/SHA-256、架构检查、可选 Ed25519 发布者签名 |
| 安装事务 | 预览令牌、执行前复查、备份全部旧文件、同目录暂存、逐文件原子替换、提交后再验哈希 |
| 恢复 | 自动恢复尝试、中断记录、重新启动后恢复、按顺序撤销、只处理拥有的文件、保护外部改动 |
| 主页与诊断 | 常驻 B 站按钮，系统浏览器打开，脱敏诊断导出，无遥测与自动上传 |
| 管理器更新 | 手动检查版本与更新日志，跳转官方发布页；不后台执行下载内容 |

## 还没有做成的部分

全新游戏的 ReShade / DLL 代理安装尚未自动化；不推断未知加载链。管理器自身的签名、原子自更新和正式发布者公钥接入尚待后续版本。硬件适配、实际画面、每个游戏的启动成功与 NR-before-SR 渲染效果需要真实机器实测，自动化测试不能替代它们。

静态扫描不能枚举所有反作弊或动态加载关系，也不是防封号保证。版本资源中的 ReShade 名称只是识别线索，不等于身份认证。Beta 没有针对恶意同权限进程进行系统级隔离的承诺。

## 对应现有 Issue

- 优先处理 [#5 事务回滚](https://github.com/smartLanny/dlss5-manager/issues/5)、[#1 文件安全](https://github.com/smartLanny/dlss5-manager/issues/1)、[#2 风险门禁](https://github.com/smartLanny/dlss5-manager/issues/2)、[#3 核心 DLL 保护](https://github.com/smartLanny/dlss5-manager/issues/3)。对未知情况保守阻止，而不是假装已验证。
- [#4 游戏发现](https://github.com/smartLanny/dlss5-manager/issues/4)、[#7 官方主页](https://github.com/smartLanny/dlss5-manager/issues/7)、[#8 独立边界](https://github.com/smartLanny/dlss5-manager/issues/8) 已有实现与对应测试。
- [#6 更新器](https://github.com/smartLanny/dlss5-manager/issues/6) 本版完成本地组件更新和版本检查，自更新部分保留待办。大范围真机验收未完成的 Issue 不因首个 Beta 发布而全部关闭。

开发期间新增的 [#10 ReShade 开箱即用](https://github.com/smartLanny/dlss5-manager/issues/10) 与 [#11 成熟功能基线](https://github.com/smartLanny/dlss5-manager/issues/11) 已纳入路线图。#10 的受控加载器分发、普通版升级、实际 loader 能力验证尚未实现，不使用“文件复制成功”冒充“插件加载成功”。#11 中的打开目录、复制路径已加入本版；Epic/GOG/Xbox、多语言、封面管理与后端切换仍待后续实现。

## 开发与构建

```sh
npm ci
npm run check
npm test
npm run test:ui
npm start
# Windows x64 构建（使用 Windows 环境或仓库 Actions）
npm run build:win
```

`npm test` 使用合成 PE 文件测试文件事务与安全边界，不执行这些文件。`npm run test:ui` 启动真实 Electron，通过实际界面导入、配置、预览；Windows 下实际写入并恢复合成测试目录，其他平台验证写入阻断。正式打包不包含测试工具或测试入口。

Windows CI 还会运行 NSIS 安装程序，验证指定安装目录、已安装 EXE 启动、卸载及恢复数据保留。发布作业依赖全部检查成功；附安装版、便携版、SHA-256 和公开组成清单。

## 文档

[兼容性矩阵](docs/COMPATIBILITY.md) · [独立更新包契约与私下分发](docs/PACKAGE-CONTRACT.md) · [Beta 发行说明](docs/RELEASE-0.1-BETA.md) · [安全边界](SECURITY.md) · [版权与组成](NOTICE.md)

原创管理器代码暂未授予开源许可，见 [LICENSE](LICENSE)。Electron/Chromium 及其他第三方组件仍遵守各自原始许可证。NR 组件权利独立，不由本仓库授予。
