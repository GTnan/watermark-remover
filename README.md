# 视频去水印上传服务

这是一个小型 Web 服务，前端负责上传视频和框选字幕/水印区域，后端负责创建任务并调用处理引擎。

实现思路参考阿里云开发者社区文章《video-subtitle-remover（VSR）--开源AI去字幕方案深度解析》：优先支持 VSR 的 STTN、LaMa、ProPainter 三类修复模式；如果服务器暂时没有安装 VSR，也可以先用 FFmpeg 的矩形区域去水印流程跑通上传、处理和下载。

## 启动

```bash
npm start
```

默认访问：

```text
http://localhost:3000
```

上传文件和处理结果会保存在 `data/` 目录。

## 接入 VSR Docker

推荐用 Docker 镜像接入 VSR，避免在服务器上手动安装 Paddle、Torch、CUDA 等依赖：

```bash
docker pull eritpchy/video-subtitle-remover:1.4.0-cpu
HOST=0.0.0.0 PORT=3000 VSR_ENGINE=docker npm start
```

如果 Docker Hub 拉取慢，可以先用镜像前缀拉取并打标签：

```bash
docker pull docker.1ms.run/eritpchy/video-subtitle-remover:1.4.0-cpu
docker tag docker.1ms.run/eritpchy/video-subtitle-remover:1.4.0-cpu eritpchy/video-subtitle-remover:1.4.0-cpu
```

网页选择 VSR 时，服务会自动调用：

```bash
docker run --rm -v ./data:/data eritpchy/video-subtitle-remover:1.4.0-cpu python backend/main.py
```

VSR 的字幕区域参数为 `YMIN YMAX XMIN XMAX`，前端框选区域会自动转换。

## 接入源码版 VSR

如果你已经源码安装了 VSR，也可以改用 Python 入口：

```bash
VSR_ENGINE=python \
VSR_MAIN=/path/to/video-subtitle-remover/backend/main.py \
VSR_PYTHON=/path/to/videoEnv/bin/python \
npm start
```

## 运行参数

```bash
HOST=0.0.0.0 PORT=3000 npm start
MAX_UPLOAD_BYTES=2147483648 npm start
VSR_DOCKER_IMAGE=eritpchy/video-subtitle-remover:1.4.0-cpu npm start
```

`MAX_UPLOAD_BYTES` 默认是 1GB。

## 说明

FFmpeg 模式适合固定位置水印的快速处理；VSR 模式适合文章中提到的硬字幕/文本水印修复场景。实际生产环境建议用反向代理加 HTTPS，并把 `data/` 定期清理或迁移到对象存储。
