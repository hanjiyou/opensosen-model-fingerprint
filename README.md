# OpenSosen Model Fingerprint

OpenSosen 模型指纹是一款 Windows x64 桌面应用。它通过本机已登录的 Codex CLI 向目标模型发送三条数字挑战，用回复中的数字序列与参考库比较，列出相似候选。每次检测使用所选通道的额度。

## 快速使用

双击便携包内的 `OpenSosenModelFingerprint.exe`。运行时需要同一目录里的 Electron 文件，以及本机可运行的官方 Windows x64 Codex CLI。原生 `codex.exe` 和官方 npm `codex.cmd` 所对应的原生程序都支持。使用 npm 安装时，可以从 `%APPDATA%\npm` 查找。

界面显示 Codex 登录方式、提供方、参考库快照，及三次采样的实际数字计数。选择列表里的文本模型并点击 **开始检测**。可随时取消。完成后可展开每次挑战和原始回复。点击 **导出 JSON** 会把证据保存到当前用户的 `文档\OpenSosen Model Fingerprint\证据`，窗口会显示完整路径。

## Codex 通道

- 连接检查调用本机 `app-server` 的 `initialize`、`account/read`、`modelProvider/list` 和 `model/list`。账号检查不会发起数字挑战。登录方式来自 Codex 报告，导出只含登录类型。
- ChatGPT 模式为采样子进程显式选择内置 `openai` 和 `https://chatgpt.com/backend-api/codex`。同一个用户可能把 Codex 的默认提供方设为自定义网关，因此界面分别显示默认提供方和该次检测的通道。若内置账号通道无法确认，界面会显示连接错误。
- API Key 模式保留 Codex 报告的 OpenAI API 地址或兼容的自定义 Responses 网关地址。自定义网关采样走 Codex 托管的 API Key。依赖额外 HTTP 头、查询参数或专用认证程序的网关配置可能无法在隔离模式使用。连接和采样结果会显示可确认的路由和错误状态。
- 采样使用 `codex exec --json --ephemeral --ignore-user-config --ignore-rules`。空的 `mcp_servers` 配置会与用户配置合并，所以采样使用 Codex 的忽略用户配置开关。每条挑战在单独的空目录与只读沙箱内运行。用 `codex debug models --bundled` 取得本机模型定义，只对采样进程去除模型附带的指令和工具。模型列表显示能映射到本机内置目录的文本模型。用户输入只有 SDK 生成的数字挑战。
- `exec` 公开事件给出会话、回复和终止状态。导出记录请求模型与配置通道，实际推理模型字段为空。认证和凭据仍由 Codex 自行管理。用户可在官方 Codex 完成登录后点击刷新。
- 桌面端对 Codex 文件存储和系统凭据库使用同一套公开账号检查。采样子进程排除认证环境变量覆盖，避免与本机账号检查报告的登录模式不一致。

## 数字证据

应用使用官方 npm 包 `lmfpd-sdk@0.2.0` 生成挑战、解析最长有效数字段并分析回复。界面保留每轮原始答复和解析数量。SDK 可用少于三个有效样本生成部分排名，部分排名会单独标识。取消、无有效数字或无法比较的结果不生成排名。[lmfpd-sdk](https://www.npmjs.com/package/lmfpd-sdk)

参考库来自 SDK 的默认数据站点或镜像，缓存放在应用的本地数据目录。下载更新时，应用会核对快照时间，并计算数据文件的 SHA-256，与清单中记录的值比对。候选排名仅反映与该参考库的相似程度。

## 构建与测试

在仓库根目录使用 Windows x64 Node.js 22.12 或更新版本执行。

```powershell
npm.cmd ci
node node_modules/electron/install.js
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

默认便携包目录为 `out/OpenSosenModelFingerprint-0.1.1-win-x64/`。要指定输出位置，可使用 `npm.cmd run build -- 'D:\OpenSosenModelFingerprint-Portable'` 并选择一个尚未创建的目录。分发时请保留整个输出目录，其中包含应用、Electron 运行时和第三方许可声明。

## 致谢

感谢 ModelTrace 及其贡献者对模型检测开源生态的贡献。 [ModelTrace](https://github.com/xqy2006/ModelTrace)
