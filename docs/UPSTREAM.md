# 上游与基线

查看本地改动：`git log <基线>..HEAD -- extensions/<name>`。

## statusline-pi
- 上游：https://github.com/luongnv89/pi-extensions （`extensions/statusline-pi`）
- 基线：`9648180` release 1.3.1（仓库其余上游历史保留在 git log 中）
- 本地改动：`a0cdb5e` 自定义页脚布局；`98281d5`、`035e1ce` PR 号查询改为不阻塞事件循环。

## pi-interactive-subagents
- 上游：https://github.com/HazAT/pi-interactive-subagents
- 基线：`c100577` release v3.7.2（subtree 导入，保留完整历史）
- 本地改动：`e5d5162` 正常结束时也写 `.exit` sidecar；`f7a39b7` 子 agent 会话命名为 `<subagent:name>`。

## pi-language-tutor
- 上游：https://github.com/mackt/pi-language-tutor
- 基线：`aeaa9fa` bump 0.5.0（subtree 导入，保留完整历史）
- 本地改动：`651d2d1` 新增 `/dismiss` 隐藏复习面板；`14d6ea3` 写作检查忽略大小写。

## pi-voice
- 上游：https://github.com/earendil-works/pi-voice
- 基线：npm 包 `@earendil-works/pi-voice@0.2.0`（完整源码、词表与 Silero VAD 模型基线导入）
- 本地改动：待补充（系统级 ASR 服务暴露）。
