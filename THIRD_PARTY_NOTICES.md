# Third-party notices

Codex 白昼 / Codex Daylight 的应用源码不依赖第三方 npm 包。

Windows 便携包包含 Node.js Windows x64 运行时。Node.js 及其内含第三方组件适用的完整许可证与声明位于便携包的 `runtime/LICENSE.txt`；同一份声明的发布模板保存在源码的 `templates/node-LICENSE.txt`。运行时版本、二进制 SHA-256、许可证 SHA-256 和对应上游来源记录在 `package-manifest.json` 与发行 `manifest.json` 中。

默认模板对应 Node.js v24.22.1，已与官方对应标签中的完整 LICENSE 比较一致。使用其他 Node.js 版本打包时，应把该版本的完整 LICENSE 路径传给 `scripts/release.ps1 -RuntimeLicensePath`。自动发布工作流会根据实际运行时版本下载对应许可证。

- [Node.js official source and notices](https://github.com/nodejs/node)
- [Node.js v24.22.1 complete LICENSE](https://github.com/nodejs/node/blob/v24.22.1/LICENSE)

便携包不包含 Codex CLI、OpenAI 登录资料或个人账户数据。Codex CLI 由使用者独立安装并登录，遵循其自身许可和服务条款。Windows PowerShell 与 .NET Windows Forms 使用系统已有组件。

本文件只说明第三方组件，不授予 Codex Daylight 应用源码新的许可。
