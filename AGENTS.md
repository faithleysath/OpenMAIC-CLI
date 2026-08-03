# AGENTS.md — Nexus (二次开发分支)

本仓库是 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 的二次开发 fork。
当前默认工作分支是 **`nexus`**，不是 `main`。

## 分支模型

| 分支 | 作用 | 跟踪 |
| --- | --- | --- |
| `main` | **只用于同步上游**，不直接开发 | `upstream/main`（原仓库） |
| `nexus` | 二开主干，所有自定义改动落在这里 | 起始于 release tag `v0.3.1` |

- 远程 `origin` = 本人的 fork（`faithleysath/OpenMAIC-CLI`）
- 远程 `upstream` = 原仓库（`THU-MAIC/OpenMAIC`）

## 上游同步策略（重要）

**永远只在上游 release tag 之间 rebase，不要 rebase 到 `main` 或 `upstream/main`。**

正确做法——从一个 release tag rebase onto 另一个 release tag：

```bash
# 假设当前基线是 v0.3.1，要升级到 v0.4.0
git fetch upstream --tags
git checkout nexus
git rebase --onto v0.4.0 v0.3.1 nexus
```

说明：`git rebase --onto <新基线> <旧基线> <分支>` 会把 `nexus` 上自 `v0.3.1` 以来的自定义提交，
重新落到 `v0.4.0` 之上，丢弃中间上游 main 上那些未随 release 发布的杂乱提交。

禁止的写法（会让 nexus 裹挟上游未发布的中间提交、并制造大量冲突）：

```bash
git rebase upstream/main   # ❌ 不要这样做
git merge main             # ❌ 不要这样做
```

如果 rebase 出现冲突，在 `nexus` 上就地解决，然后 `git rebase --continue`。
不要用 `git stash` 跨 rebase/merge 流程搬运改动。

## 基线版本记录

| 日期 | 基线 tag | nexus HEAD |
| --- | --- | --- |
| 2026-08-03 | `v0.3.1` | `04acb17c` |

升级上游 release 后，在表格追加一行记录新的基线 tag。

## 日常开发

- 包管理器：**pnpm**（Node ≥ 20.9.0）
- 安装：`pnpm install`
- 开发：`pnpm dev`
- 提交前自检（与上游 CI 对齐）：
  ```bash
  pnpm format
  pnpm lint --fix
  npx tsc --noEmit
  pnpm test          # vitest
  ```
- UI 文案必须走 i18n（`lib/i18n/locales/`），不要硬编码用户可见字符串。
- Commit message 沿用上游的 Conventional Commits（`feat`/`fix`/`docs`/...）。
- 优先在 `nexus` 上线性提交，避免引入复杂的 merge 历史。

## 二开改动约定

- 自定义改动集中在明确的模块/目录，便于升级 release 时识别冲突来源。
- 对上游文件的修改尽量小而局部；大范围改动优先通过新增文件或扩展点实现。
- 不要修改 `pnpm-lock.yaml` 的上游依赖版本，除非确有必要——会拖慢 rebase。

### 提交要干净、避免零碎

自定义提交（`nexus` 上区别于基线 tag 的提交）是 rebase 时冲突的主要来源。
提交越零碎，rebase 时逐个回放遇到冲突的次数就越多，越难处理。

- **定期压缩（squash）同一主题的连续提交**，例如同一个功能的多次试错、
  「fix lint」「fix typo」「修一下刚才的改动」这类碎片，合并成一个语义完整的提交。
- 压缩方法（交互式 rebase 到基线 tag）：
  ```bash
  git rebase -i v0.3.1      # 把要合并的提交从 pick 改成 squash/fixup
  ```
- **一个提交只做一件事**：跨主题的改动不要塞进同一个提交，
  否则冲突会卡在无关的代码上。
- 优先保持线性、语义清晰的历史；提交信息写清「改了什么、为什么」，方便
  未来 rebase 冲突时判断这段改动还需要不需要。

## 项目结构速览

```
app/          Next.js App Router（页面 + API 路由）
components/   React 组件
lib/          核心逻辑 / 工具（i18n 在 lib/i18n/locales/）
packages/     内部包（mathml2omml, pptxgenjs, @openmaic/dsl, storage, importer, renderer）
render-service/  视频导出渲染服务
scripts/      构建/同步脚本
tests/, e2e/  单元测试 / 端到端测试
```
