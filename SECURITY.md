# 安全边界

## 项目范围

本仓库仅维护独立管理器。禁止提交受保护组件的源码、真实插件、未公开运行文件、用户游戏内容和签名凭据。调试只使用合成测试数据，公开诊断必须脱敏。

仅对用户选择的本机游戏目录执行白名单文件操作。没有通配符清理，没有系统文件替换，没有修改反作弊的功能。无法确认目标、权限、完整性、进程状态或备份有效性时停止操作。

## 信任模型

本地包和所有前端输入均视为未信任。renderer 没有 Node.js 权限，启用 contextIsolation、sandbox、CSP、严格导航和 IPC 来源检查；不加载远程脚本。外部链接仅允许固定的官方入口。

文件来源、内容完整性和游戏兼容性是三件不同的事。版本资源中的产品名只是线索，SHA-256 只确认内容，公钥签名才用于发布者认证。0.1 Beta 未配置正式发布者公钥，也未配置 Windows Authenticode 证书。

管理器不以管理员权限常驻，不要求用户关闭系统保护。无法写入受限游戏目录时显示权限错误，而不是自动提升权限。

## 恢复保证的范围

正常中断和可识别失败通过持久化事务日志与快照恢复；所有备份在替换前完成，恢复前重新核对文件。外部改动或损坏备份会停止自动处理。所有文件保留，不静默覆盖。

这不是抵御任意恶意同用户权限进程的系统级隔离工具。文件预检查和最终写入之间仍存在操作系统调度窗口；游戏可能在检查后启动；真实断电、磁盘控制器故障、备份介质损坏等情形不能保证自动恢复。应保留独立游戏存档备份。

## 报告问题

普通功能问题可提交本仓库 Issue，仅附管理器生成的脱敏诊断。疑似安全问题先通过装机宅官方主页联系维护者，不公开用户路径、账号、文件内容、私钥或受保护组件实现。

## 一手资料

- Electron 安全建议：https://www.electronjs.org/docs/latest/tutorial/security
- Electron IPC 隔离：https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Microsoft 文件签名信息：https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature
- NSIS 构建参数：https://www.electron.build/nsis/
- Playwright Electron 自动化：https://playwright.dev/docs/api/class-electron
