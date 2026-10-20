# Collabo 3D打印文件管理器

3D 打印 / CAD 文件管理、浏览、预览桌面软件（Electron，Windows / macOS / Linux 可运行）。

支持格式：STL / OBJ / 3MF / STEP / IGES。

## 功能
- 添加多个目录，递归扫描并建立索引，按格式 / 目录筛选，搜索、排序、缩略图大小调节
- 3MF 秒出缩略图：先取内嵌预览图，后台渲染真实几何缩略图并替换
- 内置 3D 查看器
- Support Fins 编辑视口（`fins/`，第三方 MIT 组件）
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
