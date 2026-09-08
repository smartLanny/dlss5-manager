# 启动前 SR / MFG 配置预览实验

此文记录 PR #21 的纯编译器边界。后续 Manager 0.3.0-beta.1 已新增独立的事务、NVAPI adapter 和 UI 接入，见 [每游戏启动设置与恢复](LAUNCH-SETTINGS.md)。下述“未实现 writer”仅描述该编译器增量，不是当前整合候选的全部能力；CLI 仍然只读。

对应 Manager #18（SR）与 #19（FG/MFG）；HDR 组件另见 #20。

## 实际交付边界

这个增量提供纯配置编译函数和可执行的 stdin→stdout 预览 CLI，**不连接游戏文件、NVAPI、Manager UI 或启动操作**。没有新增假 Apply 按钮，没有安装/解锁 FG，没有改全局驱动设置。所有结果固定为 `phase=preview-only`、`applied=false`、`runtimeVerified=false`；RTX40 的 `automaticApplicationAllowed` 固定 false。

输入配置、请求与输出内容可以直接供后续现有 Engine 的事务适配使用，但预览不是一个受信任的写入授权。实际执行前必须重新从主进程确认游戏、后端/协议、配置哈希、进程状态及用户确认，并生成可靠的回滚记录。

实现落点：

- `src/core/launch-profile-plan.cjs`：输入校验、公开 SR 驱动键计划、OptiScaler INI 生成、RTX40MFG v11 JSON 生成和只读状态分析。
- `src/vendor/swapper-ini.cjs`：直接复用 Swapper 的三个纯 INI helper，保留 MIT 版权及许可，不重新造解析/写回基础。
- `scripts/preview-launch-profile.cjs`：维护者 CLI，无路径参数和写入接口，不用于普通玩家手填 JSON。
- `tests/launch-profile-plan.test.cjs`：真实生产函数与 CLI 子进程测试。

## 使用（Node 22，无 npm 依赖）

以下命令仅输出预览，不应用设置。不要将输出直接当作已验证的游戏配置安装包。

```sh
printf '%s' '{"backend":"nvapi-sr","request":{"quality":"custom","renderPercent":75,"preset":"M"}}' | node scripts/preview-launch-profile.cjs
printf '%s' '{"backend":"optiscaler-sr","originalText":"[UpscaleRatio]\nUpscaleRatioOverrideValue=1.5\n","request":{"quality":"performance"}}' | node scripts/preview-launch-profile.cjs
printf '%s' '{"backend":"rtx40-mfg","originalText":"{\"version\":11,\"mode\":\"follow\",\"followGame\":true,\"multiplier\":2}","request":{"mode":"fixed","multiplier":3}}' | node scripts/preview-launch-profile.cjs
node --test tests/launch-profile-plan.test.cjs
```

CLI 限制 UTF-8 输入大小，不接受文件路径、脚本、shell 或任意 driver key；错误返回非零退出码，没有半份成功计划。纯函数只处理传入内容，不读取环境。配置 JSON 会重新排版，未知字段按 JSON 数值语义保留；不能承诺任意文件的字节保真。备份必须保留原始字节。过大整数/非有限数/负零/过深嵌套会拒绝，未知协议不覆盖。

## 各后端语义

### 原生 NVIDIA SR

仅生成公开 NVAPI 的每应用设置意图：SR override、SR mode、SR custom ratio；K/L/M 只有显式请求时写入。SR 档位不触碰 RR/NR/FG。自定义比例为整数 33–100；SDK 可表示不等于游戏一定使用。`quality=game` 是恢复本工具拥有的设置的请求，必须有原始逐键快照；不是删除整个 profile 或写四个默认值。

**本轮未实现 NVAPI writer，也未实现50系MFG设置计划/应用。**代码中的 FG 字段 ID 仅记录已核对的公开接口，不能依据头文件 count 最大值15就开放16X。

### OptiScaler SR

适配已固定版本 `[UpscaleRatio]` 的两个键。其倍率是 O/R，75% R/O 转成约1.333333333，而不是75。预设 DLAA/质量/平衡/性能/超级性能映射1/1.5/1.7/2/3；自定义配方范围约33.333–100%。保留原 DRS/FG/NR、无关配置和 BOM/换行。目标重复键/重复节以及 helper 无法可靠处理的节头语法拒绝，不部分改写。

这是向已安装时域后端提交统一强制倍率，不是为游戏新注入一个超分后端；游戏DRS或其它覆盖仍可能影响实际R。返回的 `linearRenderPercent` 是名义比例，不是从游戏观察的结果。撤销只列出需恢复的两个自有键，恢复器应合并回原值并保留后续无关修改。

### RTX40 社区 MFG

适配上游 `RTX40MFG-Universal.json` control **v11**，使用 follow/fixed/dynamic、总倍率2–6、动态目标0–1000及显式 experimental56。没有编造off模式：跟随游戏不等于关闭FG。配置路径由真实前端决定，CET与原生前端位置不能同时盲写。

状态解析使用已核对的 heartbeat、activeWrapperObserved、safeMaximumMultiplier 和 dynamicMfgSupportKnown/Supported。缺失或旧状态不是“明确不支持”，请求可保留为待验证；超出上限不偷偷钳到另一个倍率。状态即使看似有效也没有经过进程/模块/本会话身份认证，因此**从不授权自动应用**。原 generatedOnlyDebug 保留并告警，不默默打开或关闭用户调试状态。

后端要求已存在可用 Streamline FG；本管理器预览不能给无FG游戏凭空增加MFG，也不把社区路线宣传成NVIDIA官方40系支持。

## 下一实现切片与恢复约束

复用现有 `Engine` 和 PR #16 相关生命周期工作，增加有单独操作类型/兼容状态版本的配置事务，不放宽旧安装器文件白名单来绕过它。游戏文件事务与 NVAPI profile 操作的恢复记录不同，但由同一管理入口协调；shared profile、继承值/值不存在、外部改动和失败必须明确处理。

UI 请求→主进程从可信后端重建计划→确认→启动前应用→读回→启动，Steam 与 EXE 使用同一预处理。运行中只保存下一次请求，除非另有已验证的后端live-control。50系固定/Dynamic的实际键组合、RTX40实际请求执行与恢复、运行时身份和游戏帧节奏均为后续门槛。

## 验证状态

当前 Linux Node 22 主机上19项测试全部通过，包含真实 CLI 子进程、UTF-8/字段范围、INI保留与歧义、v11协议、过期/未观察状态、follow与off差异、动态未知与不支持区分。

没有执行完整 Manager 测试套件、Windows文件/驱动/打包后UI或游戏。新增工作流只运行这19项；托管结果必须看对应提交，不继承旧CI。此模块不修改任何已发布版本或运行时渲染核心。

## 上游、许可与来源固定

- 三个 INI helper：rakanki911/DLSS5-Swapper@027d1becef8d048b757eb76ced639df583374917，`src/core/feeder-config.js`，MIT，完整许可位于 `src/vendor/SWAPPER-INI-LICENSE.txt`。
- NVIDIA公开设置：NVIDIA/nvapi@87dca625e83fd89a983e19b904e5f3a580da90d2，`NvApiDriverSettings.h`。这里只使用互操作字段，没有重发布SDK库或NVIDIA运行时。
- OptiScaler配置：optiscaler/OptiScaler@da70e61e1542a0b99adcb24168ff941e42109567，`OptiScaler.ini`。没有复制其GPL渲染/FG实现或发行DLL。
- RTX40协议：dashdogy/RTX40MFG-Unlock@4e776d068f91b4a665425542bb005dd57cc3d891，`bin/x64/plugins/cyber_engine_tweaks/mods/RTX40MFG/init.lua`。没有复制其解锁/时序补丁或NVIDIA依赖。

管理独立后端、重新分发GPL程序、与GPL代码紧密组合是不同许可问题。未来组合/分发应按真实边界审查，不能仅凭“单独DLL”推断免责；亦不将OptiScaler许可作为独立官方SR/MFG设置的阻塞。
