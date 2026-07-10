# PX4 双机 ULog 三维轨迹查看器

这是一个本地静态网页工具，用于直接读取两份 PX4 `.ulg` 飞行日志，并绘制两架无人机的三维轨迹。

## 使用方式

1. 打开 `index.html`。
2. 分别选择无人机 A、无人机 B 的 `.ulg` 日志。
3. 选择坐标模式：
   - 本地坐标：读取 `vehicle_local_position.x/y/z`
   - 全球坐标：读取 `vehicle_global_position.lat/lon/alt`
4. 点击“解析并绘制”。
5. 拖动时间轴，轨迹会绘制到当前时间点。
6. 在图中左键按住拖拽平移，右键按住拖拽旋转，滚轮缩放，悬停查看最近轨迹点。

无人机 A 在当前时间点会显示机体 FRD 坐标轴：

- F / Forward：红色
- R / Right：绿色
- D / Down：蓝色

如果某些浏览器限制 `file://` 下的脚本加载，可以在 `LogTools` 目录运行一个本地静态服务器：

```powershell
python -m http.server 8080
```

然后访问：

```text
http://localhost:8080
```

## 隐私说明

日志文件不会上传。解析和绘图都在浏览器本地完成。

## 坐标约定

- 本地坐标使用 PX4 NED 坐标系中的 `x/y/z`，绘图时将 `-z` 作为向上的高度。
- 如果两份日志都包含 `vehicle_global_position`，本地坐标模式会用两机起始全球位置估计本地原点偏移，避免两架无人机因各自 local origin 不同而起点重合。
- 全球坐标以两份日志中最早可用的全球坐标点为参考原点，将经纬高转换为 East / North / Up 米制坐标。

## 支持的 ULog topic

- `vehicle_local_position`
- `vehicle_global_position`
- `vehicle_attitude`

当前工具聚焦三维轨迹查看，不替代完整的 PX4 Flight Review。

## 本地测试

如果需要运行测试，请使用 Node.js：

```powershell
node --test tests/*.test.js
```
