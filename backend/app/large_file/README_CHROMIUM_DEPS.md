# CentOS 安装 Chromium 系统依赖

## 快速安装

```bash
cd 项目根目录（sheetbot/）/backend/app/large_file
chmod +x install_chromium_deps.sh
./install_chromium_deps.sh
```

## 手动安装（如果脚本失败）

### CentOS 7/8

```bash
# 安装基础依赖
yum install -y \
    alsa-lib \
    atk \
    cups-libs \
    gtk3 \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXrandr \
    libXScrnSaver \
    libXtst \
    pango \
    dejavu-sans-fonts \
    dejavu-serif-fonts \
    liberation-fonts \
    xorg-x11-fonts-100dpi \
    xorg-x11-fonts-75dpi \
    xorg-x11-utils
```

### CentOS 9/AlmaLinux 9

```bash
# 安装基础依赖
yum install -y \
    alsa-lib \
    atk \
    cups-libs \
    gtk3 \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXrandr \
    libXScrnSaver \
    libXtst \
    pango \
    dejavu-sans-fonts \
    dejavu-serif-fonts \
    liberation-fonts
```

## 验证安装

安装完成后，验证关键库是否存在：

```bash
# 检查 libatk-1.0.so.0（这是错误信息中缺失的库）
ldconfig -p | grep libatk

# 检查其他关键库
ldconfig -p | grep -E "libXcomposite|libXdamage|libXext|libXi|libXrandr"
```

## 如果仍然失败

如果安装依赖后仍然出现 `libatk-1.0.so.0: cannot open shared object file` 错误，可以尝试：

### 方法1：安装完整的 Chromium（推荐）

```bash
# CentOS 7/8
yum install -y chromium

# CentOS 9
yum install -y chromium-headless
```

然后修改代码使用系统 Chromium（需要修改 `report_exporter.js`）。

### 方法2：检查库路径

```bash
# 查找库文件位置
find /usr -name "libatk-1.0.so.0" 2>/dev/null

# 如果找到，添加到库路径
export LD_LIBRARY_PATH=/usr/lib64:$LD_LIBRARY_PATH
```

### 方法3：使用 Docker（备选）

如果系统依赖问题难以解决，可以考虑在 Docker 容器中运行 Node.js 导出功能。

## 常见问题

### Q: yum install 提示包不存在
A: 可能需要启用 EPEL 仓库：
```bash
yum install -y epel-release
yum update
```

### Q: 某些字体包安装失败
A: 字体包是可选的，不影响基本功能，可以忽略。

### Q: 安装后仍然报错
A: 尝试重启应用或重新加载库路径：
```bash
ldconfig
```
