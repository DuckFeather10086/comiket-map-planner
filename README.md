# Comiket 巡回地图生成器

在浏览器里点选社团位置，导出可直接打印的巡回地图 PDF。两天分开管理，每个馆一张 A4，附巡回清单。
**地图是自己画的** —— 不依赖官方 PDF，站点开箱即用，导出约 220 KB。

## 能做什么

- **点格子就能标**：地图上每个 space 都是可点的。点一下加入清单，再点选中它。
  也可以输入配置代码：`東ヨ-12a` / `ヨ12a` / `西1 あ-05b` / `南t-33a`。
- **两天分开**：1日目 / 2日目 各自清单，可分别或合并导出。
- **导出 PDF（全矢量）**：每个有标记的馆一张 A4，加一页巡回清单（勾选框、社团名、
  备注），按巡回顺序编号。**所有馆用同一个比例尺**，所以東3 印出来就是比 東1 大，
  和实际一样。
- **颜色分组**：6 色，区分优先级 / 同行的人 / 目标类型。
- **数据只在本地**：localStorage，不上传任何东西。可导出 JSON / CSV 备份。

C108 共 **8 个馆、110 个区块、5486 个 space**，全部来自实测坐标。

## 快速开始

```bash
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

没有别的步骤 —— 不需要下载官方地图。

## 部署到 GitHub Pages

推到 `main`，在 **Settings → Pages → Source** 选 **GitHub Actions**。
`.github/workflows/deploy.yml` 会先校验坐标数据再发布。站点用相对路径，放在
`https://<user>.github.io/<repo>/` 子路径下没问题。

## 地图是怎么来的

坐标一次性从官方 PDF 量出来，之后运行时不再需要它。

官方地图是印刷用矢量文件，所有文字都已转成曲线，没有可读的文本层。但几何是规律的：

- 每个区块画成一条窄长的**双列岛**，被通道切成若干个带框的段。
- 段内的横向分隔线间距完全均匀 —— 一条线一排桌子。
- 岛的左右边框在段内连续、在通道处断开，据此切分段落
  （通道里印着大大的区块字母，否则会把两段粘在一起）。
- 编号规则：N 个 space 的区块有 N/2 排，**右列自下往上 1…N/2，左列自上往下
  N/2+1…N**，同一排左右相加恒为 N+1。

`tools/extract_layout.py` 里唯一手写的部分是每页的 band 描述（哪个馆、纵向范围、
区块字母从左到右的顺序），其余全部从栅格化结果里量出来。**110 个区块 5486 个 space
全部用 `tools/debug_overlay.py` 逐格与印刷编号核对过。**

渲染时就直接画这些矩形 —— 位置 + 编号本来就是一张会场图的全部内容。
`src/mapdraw.js` 一份代码同时喂给 canvas（屏幕）和 pdf-lib（导出），
所以屏幕上看到的就是打印出来的，同一套几何还负责点击命中判定。

### 支持新一届 Comiket

```bash
tools/fetch_map.sh C109 C109Map_all_B4.pdf
# 按新地图改 tools/extract_layout.py 里的 PAGES（馆的区块字母顺序、band 的 y 范围）
python3 tools/extract_layout.py maps/C109Map_all_B4.pdf data/C109.json
python3 tools/extract_walls.py maps/C109Map_all_B4.pdf data/C109.json
python3 tools/check_layout.py data/C109.json
# 目视核对：蓝色的推算编号应当与印刷的手写编号一一对应
python3 tools/debug_overlay.py data/C109.json maps/C109Map_all_B4.pdf 1 /tmp/ov1.png
```

然后把 `src/main.js` 的 `LAYOUT_URL` 指向新文件，更新 `src/exporter.js` 里的 `DAY_LABEL`。
抽取依赖 `poppler-utils`、`numpy`、`pillow`；这些只在换届时需要，站点本身不用。

## 已知限制

- **壁サー已经画进去了**，但覆盖还不完整。壁区块的升目没有规则网格可以自动抽，
  所以做法是：把号段从 300dpi 的印刷图上读出来，声明在 `data/C108.json` 的
  `wallRuns` 里，渲染时沿着馆的对应边均匀排开。**位置沿墙有一两格的误差，
  但是哪面墙、什么顺序、什么号是准的。**
  已读出：東1/東2/東3 的 ア（1–95，89–92 是空号）、東7 的 A（1–34）、
  西1 的 め（16–57）、西2 的 あ（40–57）。
  号段之外的（西1 め 的 1–15 / 58 以后、西2 あ 的其余、南 的 a）还没读，
  这些会照旧列在图角和清单的「未定位」里 —— **不会瞎猜位置**。
  补齐是纯数据录入：往 `wallRuns` 里加 `{block, hall, page, side, from, to}` 即可。
- **墙画成线段，缺口就是门**（`tools/extract_walls.py`：形态学开运算分离出建筑，
  再把每条馆边投影成"有墙 / 没墙"的区间）。所以出入口是看得出来的，
  但**没有标注是哪个门** —— 官方图在馆内也没写，门的名称在会场指示牌上。
  两个馆相连的那一侧本来就没有墙，图上也就是空的。
- **设施没有画**：洗手间 / サークル窓口 / 地区本部 的文字标签在官方图里也是
  转成曲线的，读不出来，所以不画，避免瞎标。
- 日期文案（`DAY_LABEL`）是 C108 的 2026-08-15/16，换届需要改。
- 一格 = 一张桌子；`a` / `b` 两个 space 共用一格，标记覆盖整格，具体 a/b 写在清单里。

## 结构

```
index.html              界面
src/mapdraw.js          画地图（墙体、岛、格子、编号、区块字母）+ 点击命中
src/pens.js             两个绘制后端：canvas 与 pdf-lib
src/layout.js           配置代码解析 + 坐标解析
src/viewer.js           屏幕地图、缩放、点选
src/exporter.js         导出（每馆一张 A4 + 清单页）
src/store.js            清单状态 / localStorage / 粘贴导入
data/C108.json          桌位坐标 + 墙线 + 壁サー号段（58 KB）
tools/extract_layout.py 从官方 PDF 抽取桌位坐标
tools/extract_walls.py  把墙抽成线段（缺口 = 出入口）
tools/check_layout.py   数据自检（CI 会跑）
tools/debug_overlay.py  把推算编号叠加到官方图上，用于目视核对
vendor/pdf-lib.min.js   导出用（懒加载）
vendor/fontkit.umd.min.js  嵌入字体子集用（懒加载）
vendor/kana-subset.ttf  8.8 KB，只含地图用到的约 80 个假名/汉字
```

## 关于导出体积

全矢量，8 张馆图 + 清单约 **220 KB**。

拼数字用内置 Helvetica（零字节），假名区块字母和馆名走 8.8 KB 的字体子集，
字符串按字种切段分别落字。清单页因为社团名是任意日文（子集覆盖不了），
用 canvas 画好再嵌成图片，约 40 KB 一页。

## 授权

代码为 MIT（见 `LICENSE`）。`vendor/kana-subset.ttf` 取自 Droid Sans Fallback
（Apache-2.0，见 `vendor/DroidSansFallback-LICENSE.txt`）。
坐标数据是从公开发布的会场图量出的事实性布局信息；本仓库不包含官方地图文件，
也与 Comic Market 准备会无关。
