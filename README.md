# Comiket 巡回地图生成器

在浏览器里把你的社团清单标到 **Comiket 官方会场地图**上，导出可直接打印的 PDF。
两天分开管理，每个馆一页放大图，附巡回清单。纯静态站点，可部署到 GitHub Pages。

输入 `東ヨ-12a`，工具就知道那一格在地图上的哪个位置 —— 不需要手动对齐。

## 能做什么

- **配置代码自动定位**：`東ヨ-12a` / `ヨ12a` / `西1 あ-05b` / `南t-33a` 都能识别，
  精确到那张桌子（1 格 = 1 个 space）。C108 共 **110 个区块、5486 个 space**。
- **两天分开**：1日目 / 2日目 各自一份清单，可分别或合并导出。
- **导出 PDF**（矢量，不失真）：
  - 全馆总图，标记 + 编号
  - 每个馆一页放大图（裁切到该馆，打印时铺满 A4）
  - 巡回清单页（含勾选框、社团名、备注），按巡回顺序编号
- **颜色分组**：6 色，用来区分优先级 / 同行的人 / 目标类型。
- **手动定位**：壁社团或识别不了的写法，点 📍 直接在地图上点一下。
- **数据只在本地**：localStorage + IndexedDB，不上传任何东西。可导出 JSON / CSV 备份。

## 快速开始

```bash
# 1) 取官方地图（仓库默认不含此 PDF，见下文）
tools/fetch_map.sh C108

# 2) 本地起个静态服务器
python3 -m http.server 8000

# 3) 打开 http://localhost:8000
```

没有本地地图文件也能用：页面会让你把官方 PDF 拖进去，之后缓存在浏览器里，只需一次。

## 部署到 GitHub Pages

1. 推到 GitHub 的 `main` 分支。
2. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**。
3. `.github/workflows/deploy.yml` 会校验地图数据并发布整个仓库。

站点用的都是相对路径，放在 `https://<user>.github.io/<repo>/` 子路径下没问题。

### 关于官方地图 PDF

`maps/*.pdf` 默认被 `.gitignore` 排除 —— 那是 Comiket 的美术资源，不适合由第三方站点
再分发。代价是每个浏览器第一次打开要拖一次文件（之后 IndexedDB 缓存）。

如果你希望访问者开箱即用，删掉 `.gitignore` 里的 `maps/*.pdf` 那行再提交即可，
应用会自动优先加载 `maps/C108Map_all_B4.pdf`。这是你自己的选择。

## 支持新一届 Comiket

坐标是从官方 PDF 的图形里量出来的，所以换届只要重新跑一次抽取：

```bash
tools/fetch_map.sh C109 C109Map_all_B4.pdf
# 按新地图改 tools/extract_layout.py 里的 PAGES（每个馆的区块字母顺序、band 的 y 范围）
python3 tools/extract_layout.py maps/C109Map_all_B4.pdf data/C109.json
python3 tools/check_layout.py data/C109.json
# 目视核对：生成叠加图，蓝色的推算编号应当与印刷的手写编号一一对应
python3 tools/debug_overlay.py data/C109.json maps/C109Map_all_B4.pdf 1 /tmp/ov1.png
```

然后把 `src/main.js` 里的 `LAYOUT_URL` 指向新文件，
并更新 `src/exporter.js` 里的 `DAY_LABEL` 日期。

依赖：`poppler-utils`（`pdftoppm` / `pdfinfo`）、`numpy`、`pillow`。

### 抽取原理

官方地图是印刷用矢量文件，所有文字都已转成曲线，没有可读的文本层。但几何是规律的：

- 每个区块画成一条窄长的**双列岛**，被通道切成若干个带框的段。
- 段内的横向分隔线间距完全均匀 —— 一条线一排桌子。
- 岛的左右边框在段内连续、在通道处断开，据此切分段落
  （通道里印着大大的区块字母，否则会把两段粘在一起）。
- 编号规则：N 个 space 的区块有 N/2 排，**右列自下往上 1…N/2，左列自上往下
  N/2+1…N**，同一排左右相加恒为 N+1。

`tools/extract_layout.py` 里唯一手写的部分是每页的 band 描述
（哪个馆、纵向范围、区块字母从左到右的顺序），其余全部从栅格化结果里量出来。

## 已知限制

- **壁区块（ア / A / あ / め / a）没有自动坐标**。它们沿墙绕角画，没有规则网格。
  工具会认出代码并提示，用 📍 手动点一次即可；这些条目也会出现在清单页的
  「未定位」分组里，不会丢。
- 日期文案（`DAY_LABEL`）是 C108 的 2026-08-15/16，换届需要改。
- 一格 = 一张桌子；`a` / `b` 两个 space 共用一格，标记覆盖整格，
  具体 a/b 写在清单里。

## 结构

```
index.html              界面
src/layout.js           配置代码解析 + 坐标解析
src/store.js            清单状态 / localStorage / 粘贴导入
src/pdfsource.js        地图 PDF 来源（内置 / 拖入 / IndexedDB 缓存）
src/viewer.js           pdf.js 预览 + 标记层 + 点选定位
src/exporter.js         pdf-lib 导出（矢量标记、裁切放大页、清单页）
data/C108.json          抽取出的坐标（52 KB）
tools/extract_layout.py 从官方 PDF 抽取坐标
tools/check_layout.py   数据自检（CI 会跑）
tools/debug_overlay.py  把推算编号叠加到地图上，用于目视核对
vendor/                 pdf.js 4.10 + pdf-lib 1.17（已内置，不依赖 CDN）
```

## 关于导出体积

输出保持矢量，因此地图上的手写编号在任何缩放下都清晰。全部四页都有标记时约
5.4 MB；只标一个馆约 1.3 MB。

体积几乎全部来自地图本身的矢量线条（官方 PDF 5.5 MB 中约 3.5 MB 是曲线路径，
图片部分本来就已经是 JPEG），所以重新压缩图片省不了多少。真正有效的是：

- 用一次 `copyPages()` 复制所有需要的页 —— pdf-lib 会共享同一份美术资源并保留
  原始压缩流；`embedPage()` 会解压内容，体积多出约 45%。
- 每页放大图只是同一页的又一份副本，改掉 MediaBox/CropBox 裁切 —— 几乎零成本
  （8 张放大页合计约 2 KB）。
- 只复制真正用到的页：只标东馆就不会带上西馆和南馆。

## 授权

代码为 MIT（见 `LICENSE`）。会场地图 PDF 版权归 Comic Market 准备会所有，
不包含在本仓库中，也不适用本授权。本工具与准备会无关。
