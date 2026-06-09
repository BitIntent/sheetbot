# 本地资源准备说明

## 概述

报表导出功能已改为使用本地资源，避免依赖外部 CDN，提高稳定性和速度。

## 资源准备

### 1. 运行准备脚本

首次使用前，需要运行准备脚本将 ECharts 库复制到本地：

```bash
cd /usr1/python/excel-ai/backend/app/large_file
node prepare_local_resources.js
```

脚本会：
- 从 `frontend/node_modules/echarts/dist/echarts.min.js` 复制到 `frontend/public/lib/echarts.min.js`
- 创建必要的目录结构

### 2. 验证资源

检查文件是否存在：

```bash
ls -lh /usr1/python/excel-ai/frontend/public/lib/echarts.min.js
```

如果文件存在且大小合理（通常 > 500KB），说明准备成功。

## 字体支持

- **中文字体**：自动下载 Noto Sans SC 字体（Regular 和 Bold）并内联到 HTML 中
- **字体位置**：`frontend/public/fonts/NotoSansSC-Regular.woff2` 和 `NotoSansSC-Bold.woff2`
- **后备方案**：如果字体下载失败，将使用系统字体（Microsoft YaHei、SimSun、SimHei）
- **字体嵌入**：字体文件会转换为 base64 并内联到 HTML 中，确保 Puppeteer 能正确渲染中文

## 优势

1. **无需网络**：完全离线工作，不依赖外部 CDN
2. **更快速度**：本地资源加载速度更快
3. **更高稳定性**：避免网络超时和 CDN 故障
4. **更好控制**：可以固定版本，避免 CDN 更新导致的兼容性问题

## 故障排查

### 问题：ECharts 库加载失败

**错误信息**：`未找到 ECharts 库，请运行 prepare_local_resources.js 准备资源`

**解决方案**：
1. 确保已运行 `npm install` 安装依赖
2. 运行 `node prepare_local_resources.js` 准备资源
3. 检查 `frontend/public/lib/echarts.min.js` 是否存在

### 问题：中文显示为方框

**原因**：字体文件未下载或加载失败

**解决方案**：

1. **检查字体文件是否存在**：
   ```bash
   ls -lh /usr1/python/excel-ai/frontend/public/fonts/
   ```

2. **如果字体文件不存在或大小为 0**，尝试以下方法：

   **方法 A：使用手动下载脚本（推荐）**
   ```bash
   cd /usr1/python/excel-ai/backend/app/large_file
   chmod +x download_fonts_manual.sh
   ./download_fonts_manual.sh
   ```

   **方法 B：使用 curl 手动下载**
   ```bash
   mkdir -p /usr1/python/excel-ai/frontend/public/fonts
   cd /usr1/python/excel-ai/frontend/public/fonts
   
   # 下载 Regular 字体
   curl -L -o NotoSansSC-Regular.woff2 \
       "https://fonts.gstatic.com/s/notosanssc/v36/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnY1Mziu.woff2"
   
   # 下载 Bold 字体
   curl -L -o NotoSansSC-Bold.woff2 \
       "https://fonts.gstatic.com/s/notosanssc/v36/k3kPo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnY1Mziu.woff2"
   ```

   **方法 C：如果无法访问 Google Fonts，使用系统字体**
   ```bash
   # CentOS/RHEL
   yum install -y wqy-microhei-fonts wqy-zenhei-fonts
   
   # 然后修改 report_exporter.js 使用系统字体路径
   # 或者使用其他中文字体包
   ```

3. **验证字体文件**：
   ```bash
   ls -lh /usr1/python/excel-ai/frontend/public/fonts/
   # 应该看到两个文件，每个文件大小应该 > 100KB
   ```

## 更新资源

如果更新了 ECharts 版本，需要重新运行准备脚本：

```bash
npm install  # 更新依赖
node prepare_local_resources.js  # 重新准备资源
```
