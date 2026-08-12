# Comiket 巡回地图生成器

在**官方会场地图**上点选社团位置，导出可直接打印的巡回 PDF。两天分开管理，
每个馆一张裁切放大页，附巡回清单。纯静态站点，部署在 GitHub Pages。

官方地图 PDF 随仓库发布，打开就能用，不需要任何下载步骤。

## 能做什么

- **点格子就能标**：地图上每个 space 都是可点的。C108 共 **110 个区块、5486 个
  space**，坐标从官方 PDF 里量出来，点哪格就是哪格。也可以输入配置代码：
  `東ヨ-12a` / `ヨ12a` / `西1 あ-05b` / `南t-33a`。
- **壁サー也能标**：`東ア-31a` 这类会落在正确的墙上（见下方说明）。
- **两天分开**：1日目 / 2日目 各自清单，可分别或合并导出。
- **导出 PDF**：官方地图页 + 每个有标记的馆一张裁切放大页 + 巡回清单页
  （勾选框、社团名、备注），按巡回顺序编号。标记是矢量，清单是真文字。
- **颜色分组**：6 色，区分优先级 / 同行的人 / 目标类型。
- **数据只在本地**：localStorage，不上传任何东西。可导出 JSON / CSV 备份。

## 快速开始

```bash
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 部署到 GitHub Pages

推到 `main`，在 **Settings → Pages → Source** 选 **GitHub Actions**。
`.github/workflows/deploy.yml` 会先校验坐标数据再发布。站点用相对路径，
放在 `https://<user>.github.io/<repo>/` 子路径下没问题。

## 坐标是怎么来的

官方地图是印刷用矢量文件，所有文字都已转成曲线，没有可读的文本层。但几何是规律的：

- 每个区块画成一条窄长的**双列岛**，被通道切成若干个带框的段。
- 段内的横向分隔线间距完全均匀 —— 一条线一排桌子。
- 岛的左右边框在段内连续、在通道处断开，据此切分段落
  （通道里印着大大的区块字母，否则会把两段粘在一起）。
- 编号规则：N 个 space 的区块有 N/2 排，**右列自下往上 1…N/2，左列自上往下
  N/2+1…N**，同一排左右相加恒为 N+1。

`tools/extract_layout.py` 里唯一手写的部分是每页的 band 描述（哪个馆、纵向范围、
区块字母从左到右的顺序），其余全部从栅格化结果里量出来。**110 个区块 5486 个
space 全部用 `tools/debug_overlay.py` 逐格与印刷编号核对过**，所以标记落在哪格是准的。

### 壁サー

壁区块（ア / A / あ / め / a）沿墙绕角排布，没有规则网格可以自动抽。做法是把号段从
300dpi 的印刷图上读出来，声明在 `data/C108.json` 的 `wallRuns` 里，
渲染时沿着馆的对应边均匀排开：

| 区块 | 路线 |
|---|---|
| ア（東1/2/3） | 東1 右墙自下而上 1→22 → 上墙自右向左 23→73 → 東3 左墙自上而下 74→95 |
| A（東7） | 东南斜墙 1→18 → 上墙自右向左 19→34 |
| め（西1） | 左墙自下而上 16→39 → 上墙自左向右 40→57 |
| あ（西2） | 上墙自右向左 40→57 |

**哪面墙、什么顺序、什么号是准的；沿墙位置有一两格误差**，所以壁サー的标记画成虚线框，
提醒你以图上印着的号码为准。ア 的 89–92 是空号（印刷图确认过），不会算进去。

号段之外的（西1 め 的 1–15 / 58 以后、西2 あ 的其余、南 的 a）还没读，会列在清单的
「未定位」里 —— 不会瞎猜位置。补齐是纯数据录入：往 `wallRuns` 里加
`{block, hall, page, side, from, to}` 即可。

### 支持新一届 Comiket

```bash
tools/fetch_map.sh C109 C109Map_all_B4.pdf
# 按新地图改 tools/extract_layout.py 里的 PAGES（馆的区块字母顺序、band 的 y 范围）
python3 tools/extract_layout.py maps/C109Map_all_B4.pdf data/C109.json
python3 tools/check_layout.py data/C109.json
# 目视核对：蓝色的推算编号应当与印刷的手写编号一一对应
python3 tools/debug_overlay.py data/C109.json maps/C109Map_all_B4.pdf 1 /tmp/ov1.png
```

然后把 `src/main.js` 的 `LAYOUT_URL` 指向新文件，更新 `src/exporter.js` 里的
`DAY_LABEL`，壁サー号段重新读一遍写进 `wallRuns`。
抽取依赖 `poppler-utils`、`numpy`、`pillow`；只在换届时需要，站点本身不用。

## 结构

```
index.html              界面
src/viewer.js           pdf.js 渲染官方地图 + 标记层 + 点选
src/mapdraw.js          space 坐标解析（岛 / 壁）+ 点击命中
src/layout.js           配置代码解析
src/exporter.js         导出（官方地图页 + 各馆裁切页 + 清单页）
src/pdfsource.js        取仓库里的官方地图
src/store.js            清单状态 / localStorage / 粘贴导入
src/pens.js             按字种切分字符串（CJK 字体没有拉丁字母）
data/C108.json          坐标 + 壁サー号段（52 KB）
maps/C108Map_all_B4.pdf 官方会场地图
tools/extract_layout.py 从官方 PDF 抽取坐标
tools/check_layout.py   数据自检（CI 会跑）
tools/debug_overlay.py  把推算编号叠加到官方图上，用于目视核对
vendor/                 pdf.js 4.10 / pdf-lib 1.17 / fontkit / JIS 第1水准字体
```

## 关于导出体积

标记全是矢量画在官方页上。导出约 4.4 MB，其中官方地图本身占大头 —— 那 5.5 MB
里约 3.5 MB 是把手写编号转成曲线的路径数据，图片部分本来就已经是 JPEG，重新压缩省不了。
真正有效的是：

- 用一次 `copyPages()` 复制所有需要的页，pdf-lib 会共享同一份美术资源并保留原始
  压缩流；`embedPage()` 会解压内容，体积多出约 45%。
- 每个馆的放大页只是同一页的又一份副本，改掉 MediaBox/CropBox 裁切 —— 几乎零成本。
- 只复制真正用到的页：只标东馆就不会带上西馆和南馆。
- 清单页约 300 KB，是那份日文字体（pdf-lib 的 CJK 子集化会静默丢字形，只能整份嵌入），
  不勾选清单就不会带。

## 授权

代码为 MIT（见 `LICENSE`）。`vendor/jis-level1.ttf` 取自 Droid Sans Fallback
（Apache-2.0，见 `vendor/DroidSansFallback-LICENSE.txt`）。
`maps/C108Map_all_B4.pdf` 是 Comic Market 准备会公开发布的会场地图，版权归其所有，
本仓库仅为使用方便随附，不适用本项目授权。本项目与准备会无关。
