# PX4 双机 ULog 三维轨迹查看器

一个可直接在浏览器中打开的静态网页工具，用于读取两份 PX4 `.ulg` 飞行日志，并绘制两架无人机的三维轨迹。

在线使用地址：

[https://patrickstarxx.github.io/LogTools/](https://patrickstarxx.github.io/LogTools/)

## 功能特点

- 直接选择两份 `.ulg` 日志文件，无需上传服务器
- 同时显示无人机 A、无人机 B 的三维轨迹
- 支持本地坐标 / 全球坐标两种轨迹模式
- 支持时间轴拖动，按时间渐进绘制两条轨迹
- 在当前时间点显示无人机 A 的机体 FRD 坐标轴
- 支持为无人机 A 叠加一条可配置的机体系“视线”直线
- 支持鼠标交互查看三维轨迹

## 在线使用

打开上面的 GitHub Pages 链接后：

1. 选择无人机 A 的 `.ulg` 文件
2. 选择无人机 B 的 `.ulg` 文件
3. 选择坐标模式
4. 可选输入“视线角度（deg）”和“视线长度（m）”
5. 点击“解析并绘制”
6. 拖动时间轴，查看两架无人机随时间变化的轨迹

## 鼠标操作

- 左键按住拖拽：平移
- 右键按住拖拽：旋转
- 滚轮：以鼠标所在位置为中心缩放

## 姿态与视线显示

在当前时间点，会为无人机 A 显示机体 FRD 坐标轴：

- F / Forward：红色
- R / Right：绿色
- D / Down：蓝色

另外可叠加一条机体系视线：

- 起点：机体原点
- 所在平面：F-D 平面
- 角度定义：`0°` 沿 `+F` 方向
- 正角度：朝 `-D` 方向偏转
- 负角度：朝 `+D` 方向偏转
- 长度：由页面输入框设置

## 坐标说明

### 本地坐标模式

- 读取 `vehicle_local_position`
- PX4 原始局部坐标为 NED
- 绘图时转换到 ENU 视图坐标进行显示
- 若两份日志都包含全球位置数据，会利用两机起始全球位置估计 local origin 偏移，避免两机起点错误重合

### 全球坐标模式

- 读取 `vehicle_global_position`
- 以日志中最早可用的全球坐标点作为参考原点
- 将经纬高转换为米制 East / North / Up 坐标显示

### 机体姿态

- 机体姿态由日志中的 `vehicle_attitude` 读取
- 机体坐标轴方向基于日志数据确定

## 支持的 ULog topic

- `vehicle_local_position`
- `vehicle_global_position`
- `vehicle_attitude`

## 本地运行

本项目是纯静态网页，通常可以直接打开 `index.html` 使用。

如果浏览器限制 `file://` 方式加载脚本，也可以在项目目录启动一个本地静态服务器：

```powershell
python -m http.server 8080
```

然后访问：

```text
http://localhost:8080
```

## 隐私说明

- 日志文件不会上传
- 解析与绘图均在浏览器本地完成
- 适合离线分析和内部分享

## 项目结构

```text
LogTools/
├─ index.html
├─ assets/
│  ├─ app.css
│  ├─ app.js
│  ├─ trajectory.js
│  ├─ ulog-parser.js
│  └─ viewer3d.js
├─ tests/
└─ ulogs/
```


