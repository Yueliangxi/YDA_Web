# YDA 行情

根据仓库内的 `YDA价格汇总与每日行情.xlsx` 生成的静态行情网页。

网站地址：[YDA 行情](https://yueliangxi.github.io/YDA_Web/)。

## 图表与数据口径

- 价格分布：读取「价格发行与成交」工作表，横轴为价格（HK），纵轴为数量（YDA）。每个价格的柱子按「价格新高发行」与「成交量新高发行」堆叠，叠加蓝色的实际成交量折线，共用数量轴。点击图例可以切换各系列。
- 每日行情：读取「每日K线」工作表，以开盘、收盘、最低、最高价绘制日 K 线，并显示每日成交量。无成交日保留，沿用前一日收盘价。
- 表一按价格汇总发行数量与实际成交量，表二按日期汇总实际成交行情。发行量和成交量口径不同，堆叠柱只合计两类发行数量。
- 日期沿用 Excel 中从「第1年」开始的模拟日历及其顺序，不按公历转换。浏览器的时区不会改变日期。
- 所有价格单位均为 HK，所有数量单位均为 YDA。

图表支持缩放、范围选择以及数据详情查看，布局适配电脑和手机。每日 K 线可选择起止模拟日期，逐日查看开高低收、成交量、成交额与笔数。展开每日数据表后，可下载当前日期区间的 CSV（包含单位及状态，UTF-8 编码）。

## 本地预览

需要 Python 3，无需安装 Python 第三方包或运行前端打包工具。在仓库根目录运行：

```sh
python3 scripts/build_data.py
python3 -m unittest discover -s tests
python3 -m http.server 8000
```

打开 [本地预览](http://localhost:8000)。网页通过 HTTP 读取 JSON 数据，请通过本地服务器访问。

## 更新行情

1. 更新根目录中的 `YDA价格汇总与每日行情.xlsx`，保留原工作表与列结构。
2. 运行 `python3 scripts/build_data.py` 重新生成 `data/market.json`。
3. 运行 `python3 -m unittest discover -s tests` 检查数据转换。
4. 提交 Excel、生成的数据及相关改动，推送到 `main`。

GitHub Actions 会重新读取 Excel、验证数据，并自动部署网页。也可以在仓库 Actions 中手动运行 **Deploy YDA market page**。转换或测试失败会阻止本次发布，已发布的网站不受影响。

## GitHub Pages

仓库的 **Settings → Pages → Build and deployment → Source** 使用 **GitHub Actions**。工作流位于 `.github/workflows/pages.yml`，部署到 `github-pages` 环境。

发布产物只包含网页、JSON 数据、图表库和图标。Excel 保留在仓库用于后续生成数据，不复制到网站发布目录。

## 文件与依赖

- `index.html`、`styles.css`、`app.js`：网页结构、样式和交互。
- `scripts/build_data.py`：从 Excel 提取并校验数据。
- `data/market.json`：网页读取的数据。
- `tests/`：数据转换测试。
- `vendor/`：本地保存的 Apache ECharts 6.1.0 及其 LICENSE、NOTICE，无需访问外部 CDN。

网页为纯静态实现，无后端服务。
