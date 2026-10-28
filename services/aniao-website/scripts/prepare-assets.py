import pathlib
import sys
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
root = pathlib.Path(__file__).resolve().parents[1]
assets = root / "public/assets"

# ========================================================================
# 步骤1：将授权二次元插画适配为官网主视觉
# 数据源：StockCake CC0 插画与真实桌面程序截图。
# 操作：1) 保留原插画主体，仅调整构图和输出格式；2) 内容图片使用本地 WebP。
# ========================================================================
print("开始准备官网图片资源", flush=True)
source = Image.open(assets / "creator-source.jpg").convert("RGB")
canvas = Image.new("RGB", (1800, 1000), "#f3f8fc")
art = source.resize((1000, 1000), Image.Resampling.LANCZOS)
mask = Image.new("L", (1000, 1000))
mask.putdata([min(255, round((x / 280) ** 1.3 * 255)) for _y in range(1000) for x in range(1000)])
canvas.paste(art, (800, 0), mask)
canvas.save(assets / "aniao-hero-v1.webp", "WEBP", quality=92, method=6)
workspace = Image.open(assets / "workspace-source.png").convert("RGB")
workspace.thumbnail((1600, 1100), Image.Resampling.LANCZOS)
workspace.save(assets / "workspace-v1.webp", "WEBP", quality=94, method=6)
print(f"主视觉：1800×1000；产品截图：{workspace.width}×{workspace.height}", flush=True)
print("官网图片资源准备结束", flush=True)
