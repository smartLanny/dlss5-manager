# 发行组件与玩家操作分离

目标完整包预置推荐版 0.3.3.4、测试版 0.4.1beta，后续版本可追加。公开源码不依赖、查询或复制 NR 私有源码/未公开构建。当前可用公共管理器构建没有成品输入，`resources/components/catalog.json` 的 packages 为空，发行组成必须如实说明。

发行方在管理器仓库以外放置已经获准分发的标准 `.dlss5pkg` 文件和 `distribution.json`。清单结构为 `redistributionApproved: true`、`packages: [{file, sha256}]`。运行 `npm run pack:distribution -- <该目录>`，工具校验原包、版本和文件完整性，再写入忽略的 resources/components/*.dlss5pkg 与本地构建目录。接着 `npm run build:win`。

这一步是维护者发行工作，不是玩家安装步骤。玩家拿到完整包无需导入或填版本、API、哈希。缺任一首发组件时打包工具报错，不用空入口冒充已内置。NR 原始文件字节不改写，签名凭据不进入仓库。发布包组成清单按实际资源计算，不硬编码 addonBundled=true。

当前普通管理器允许玩家选择已经拿到的作者发布包或裸 addon。版本从包清单或发行文件名读取；未知版本显示“本地更新”。裸文件缺 API 清单时仅按自动检测目标进行明确提示的测试，不宣称兼容。程序不会为此打开或分析渲染实现。

ReShade 官网固定版本只在用户机器与临时 CI 中下载、核验、提取。不重新分发官方安装器或 DLL；测试产物也不包含它们。
