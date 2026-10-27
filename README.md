# Collabo 3D打印文件管理器

3D 打印 / CAD 文件管理、浏览、预览桌面软件（Electron，Windows / macOS / Linux 可运行）。

支持格式：STL / OBJ / 3MF / STEP / IGES。

## 功能
- **Eagle 风格三栏**：左栏素材库（全部 / 格式分类 / 监控目录 + 数量）、中栏搜索与缩略图网格、右栏详情（预览、尺寸、面数、路径、备注、操作）
- 多选：单击 / Ctrl 多选 / Shift 连选 / 空白处拖框 / Ctrl+A；右键或卡片 ⋮ 菜单
- **批量改名**（右键或 F2）：主名称、序号起始与位数、前后缀、查找替换，实时预览并校验（非法字符、重名、目标已存在、不改扩展名），两阶段改名保证互换安全，缩略图与备注随文件迁移
- 3MF 秒出缩略图：先取内嵌预览图，后台渲染真实几何缩略图并替换
- 双击进入 **Support Fins 编辑视口**（窗口内嵌，来自第三方 MIT 组件），可一键切换到基础 3D 预览
- 白 / 黑主题（`查看 → 深色主题`，原生标题栏同步并记忆），全界面直角无圆角
- 备注（每个模型一条，自动保存）
- 本地只读 REST + MCP API：仅监听 `127.0.0.1`，每次启动轮换 Bearer Token

## 运行
```bash
npm install
npm start
npm test            # 端到端自测（需设置环境变量，见 test/selftest.js）
npm run dist        # 打 Windows 安装包（electron-builder）
```
无 GPU / 远程桌面环境：`COLLABO_SOFTGL=1 npm start`。

## 许可
MIT，第三方组件见 `THIRD-PARTY-NOTICES.md`。
