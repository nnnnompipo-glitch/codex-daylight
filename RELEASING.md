# 发布与版本归档

这是 Codex 白昼的独立仓库，不依赖求职助手或浏览器扩展。版本号以根目录 `package.json` 为准，应用通过 `identity.mjs` 读取同一版本。

## 本地准备

1. 修改根目录 `CHANGELOG.md`，只记录已经完成的新增、修复、兼容变化和验证结果。保留历史条目与已有提交链接。首个 `0.1.0` 为预览发行。
2. 更新 `package.json` 版本，确认文档和所有运行模块使用同一版本来源。此项目没有扩展 manifest。
3. 在仓库根目录执行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1
   ```

   脚本先运行应用和打包检查，再从明确的源码清单导出文件，生成源码 ZIP、附带 Node.js 的 Windows x64 便携 ZIP、SHA256SUMS 与 manifest，并保存本地快照。可以指定 `-RuntimePath`、`-RuntimeLicensePath`、`-OutputDirectory` 或 `-ArchiveDirectory`。

4. 只有本地文件与一个真实完整 Git commit 逐文件一致时，才添加 `-CommitRef`。初次尚未提交的本地构建应留空；manifest 会明确记录 `commitRef: null`，不会编造提交依据。

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -CommitRef <完整40位提交号>
   ```

5. `-SourceOnly` 只生成源码包和校验归档，不附带 Node.js；`-PassThru` 返回产物路径对象。`-SkipTests` 只用于对已验证的完全相同源码补充提交号快照，不替代发布前的检查。

## GitHub 发布

GitHub Actions 的 CI 不调用模型或读取账户额度。发布工作流根据仓库实际提交打包，按运行时版本下载 Node.js 完整 LICENSE，生成预览发行和可下载附件。仓库需要允许工作流创建 release；工作流使用 GitHub 提供的临时令牌，不保存个人认证信息。

常规 main 推送会检查并打包新版本；若已在本机完成构建并将手动上传附件，可在该次提交信息中加 `[skip release]` 跳过自动发布，CI 仍照常执行。也可在 Actions 中手动触发发布。

已发布的同版本内容保持不变。后续功能或修复提升版本号后重新发布；不要用覆盖附件的方式把不同源码伪装成原版本。对同版本做本地历史核验或补充记录时保留为新快照。

## 产物与本地快照

默认 `dist/` 内的产物：

- `codex-daylight-<版本>-source.zip`：干净仓库源码，保留 `.gitignore`、`.gitattributes` 和工作流。
- `codex-daylight-<版本>-windows-x64.zip`：应用源码和 `runtime/node.exe`、完整 LICENSE、运行时来源及包 manifest。
- `SHA256SUMS.txt`、`manifest.json`：每个源码文件和打包产物的 SHA-256、真实提交号或空值、构建时间与运行时信息。

本地 `版本归档/v<版本>/<UTC时间-源码摘要-唯一标识>/` 保存这一次真实文件、产物、manifest 和校验文件。已有同名输出内容相同时复用，内容不同时生成新名称；已有快照从不覆盖。ZIP 对相同输入采用稳定顺序和固定时间戳，方便比较校验值。

核验某个快照：

```powershell
node scripts/release-core.mjs --verify "版本归档/v0.1.0/<快照目录>"
```

源码只从 `scripts/release-core.mjs` 导出的 `SOURCE_FILES` 清单读取，不遍历整个工作目录。`版本归档/`、`private/`、`runtime/`、`dist/`、`node_modules/`、运行日志、个人材料与认证文件不能提交到源码仓库。官方第三方 LICENSE 模板可以公开提交；它不包含用户账户状态。
