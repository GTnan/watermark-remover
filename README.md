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

## 接入 VSR

先在服务器安装 VSR：

```bash
git clone https://github.com/YaoFANGUK/video-subtitle-remover.git
cd video-subtitle-remover
python -m venv videoEnv
source videoEnv/bin/activate
pip install -r requirements.txt
```

然后启动本服务时指定 VSR 入口：

```bash
VSR_MAIN=/path/to/video-subtitle-remover/backend/main.py VSR_PYTHON=/path/to/videoEnv/bin/python npm start
```

如果你使用的 VSR 版本 CLI 参数不同，请调整 `server.js` 里的 `vsrArgs()`。不同开源版本可能对输入、输出、字幕区域参数命名有差异。

## 运行参数

```bash
HOST=0.0.0.0 PORT=3000 npm start
MAX_UPLOAD_BYTES=2147483648 npm start
```

`MAX_UPLOAD_BYTES` 默认是 1GB。

## 说明

FFmpeg 模式适合固定位置水印的快速处理；VSR 模式适合文章中提到的硬字幕/文本水印修复场景。实际生产环境建议用反向代理加 HTTPS，并把 `data/` 定期清理或迁移到对象存储。
