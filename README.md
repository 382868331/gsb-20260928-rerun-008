# 多边形图像数据标注平台

人工多边形标注生产流程的最小可用落地：批量导入图片 → 绘制物体轮廓（支持重叠物体、
带孔轮廓、同一物体的多个独立轮廓）→ 修改类别 → 草稿自动保存 → 提交一个不可变的固定版本。

## 技术栈

- 后端：Python 3 标准库（`http.server` + JSON 原子写文件存储），**零第三方依赖**，
  因此在无网络/无 SQLite 的环境也能运行。图片按 SHA-256 内容寻址存储。
- 前端：React 19 + TypeScript + Vite，SVG 画布。

## 运行


    # 1) 构建前端（node_modules 已在 frontend/ 下）
    cd frontend && npx vite build && cd ..

    # 2) 启动后端（同时托管前端 dist 与 /api）
    cd backend
    python3 server.py            # 默认端口 8000，可用 PORT 覆盖
    # 数据目录可用 DATA_DIR 覆盖，默认 ../data

开发模式：`npx vite`（5173，已配置 `/api` 代理到 8000）。

打开浏览器访问 http://localhost:8000 。

## 关键设计（对应验收点）

- **缩放不改变真实坐标**：所有点存为相对图片像素的归一化坐标 `[0..1]`，
  同时在图片元数据中记录 `width/height`；画布缩放只改视图映射，
  导出时可还原为任意分辨率下的真实像素坐标。
- **同一物体的多个轮廓共享一个身份**：一个标注是 GeoJSON 风格的 MultiPolygon：
  `geometry = [ polygon, ... ]`，每个 polygon 是 `[外环, 孔, 孔...]`。
  “+同一物体新轮廓”向同一 `object_id` 追加独立 polygon；“+孔洞”向某个外环追加内环。
- **重叠物体互不干扰**：不同标注独立命中检测（点在多边形内，孔内视为外部）。
- **固定版本不可被草稿覆盖**：提交时把图片清单与标注整体快照为 `data/versions/v0001.json`，
  带整体 SHA-256 `digest`；之后修改草稿并再次提交只产生新版本，历史版本文件不再被写。
  前端可只读回看任意版本。
- **导出再导入能找回图片↔标注对应**：导出 zip 内含 `manifest.json`
  （图片清单 `sha256/filename/width/height/...` + 按图片 id 组织的标注）
  与按内容哈希命名的图片文件。导入时以 **SHA-256 内容哈希** 匹配，
  与文件名无关。
- **缺图片绝不悄悄错配**：导入先做整包校验（所有缺失/哈希不符收集齐全），
  任何一张图片缺失或内容与声明哈希不符，整包拒绝（HTTP 422，返回
  明确的 `missing` / `hash_mismatch` 列表），不落任何数据。
- **中途关闭页面**：草稿 600ms 防抖自动保存到后端；重载后按图片/`object_id`
  完整恢复，关闭时若仍有未落盘修改会弹离开确认。

## API

- `GET  /api/state` — 项目、草稿、版本列表
- `POST /api/images` — multipart 批量上传（按内容哈希去重）
- `GET  /api/images/{id}/raw` — 原图
- `POST /api/draft` — 整体替换草稿（服务端做几何与归属校验）
- `POST /api/versions` — 提交不可变版本
- `GET  /api/versions[/{n}]` — 版本列表/快照
- `GET  /api/export[?version=n]` — 下载 zip（草稿或某固定版本）
- `POST /api/import` — 上传 zip 导入（哈希校验，缺图/错图整包拒绝）

## 测试

- 后端逻辑：`cd backend && python3 test_platform.py`（8 项）
- 端到端 HTTP：`cd backend && python3 test_http.py`
  （沙箱禁止建 socket，使用进程内假连接，覆盖上传/去重/草稿/版本冻结/
  导出/篡改/缺图拒绝/哈希重映射）
- 前端几何：`cd frontend && npx vitest run`
