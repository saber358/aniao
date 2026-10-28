import hashlib
import json
import logging
import os
import pathlib
import shutil
import subprocess
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("aniao-website")
release = pathlib.Path(__file__).resolve().parent
website = pathlib.Path("/var/www/html")
manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
mutable = {"index.html", "downloads/updates/linux/x64/latest-linux.yml", "downloads/updates/win/latest.yml"}
allowed = {
    "index.html", "site-v2.css", "site-v1.js", "assets/aniao-hero-v1.webp",
    "assets/workspace-v1.webp", "assets/icons.svg", "assets/favicon.svg",
    "assets/lucide-LICENSE.txt",
    "downloads/Aniao-Harness-0.80.23-windows-x64-setup.exe",
    "downloads/Aniao-Harness-0.80.23-linux-amd64.deb",
    "downloads/aniao-0.80.23-SHA256SUMS.txt",
    "downloads/updates/linux/x64/Aniao-Harness-0.80.23-linux-amd64.deb",
    "downloads/updates/linux/x64/latest-linux.yml",
    "downloads/updates/win/Aniao-Harness-0.80.23-windows-x64-setup.exe",
    "downloads/updates/win/Aniao-Harness-0.80.23-windows-x64-setup.exe.blockmap",
    "downloads/updates/win/latest.yml",
}


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def replace_file(source, destination):
    pending = destination.with_name(destination.name + "." + release.name + ".next")
    shutil.copyfile(source, pending)
    pending.chmod(0o644)
    with pending.open("rb") as stream:
        os.fsync(stream.fileno())
    os.replace(pending, destination)


# ========================================================================
# 步骤1：核对完整资产和线上文件快照
# 数据源：本次暂存清单、安装包摘要与部署前静态文件快照。
# 操作：1) 禁止覆盖不同内容的版本资产；2) 后台、旧更新源和配置只读核对。
# ========================================================================
logger.info("开始核对官网发布资产")
assert manifest["version"] == "0.80.23"
assert {item["destination"] for item in manifest["files"]} == allowed
for item in manifest["files"]:
    relative = pathlib.PurePosixPath(item["source"])
    assert not relative.is_absolute() and ".." not in relative.parts
    source = release / "payload" / relative
    destination = website / item["destination"]
    assert source.resolve().is_relative_to((release / "payload").resolve())
    assert destination.resolve().is_relative_to(website.resolve())
    assert source.stat().st_size == item["size"]
    assert digest(source) == item["sha256"], item["source"]
    if destination.exists() and item["destination"] not in mutable:
        assert digest(destination) == item["sha256"], "版本资源已有不同内容：" + item["destination"]

# 1.1 备份在任何线上切换之前完成，也防止覆盖同时发生的其他部署。
for name, expected in manifest["baseline"].items():
    path = website / name
    current = digest(path) if path.exists() else None
    assert current == expected, "线上文件已被修改：" + name
    if path.exists():
        backup = release / "previous" / name
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, backup)
subprocess.run(["systemctl", "is-active", "--quiet", "nginx", "aniao-backend"], check=True)
logger.info("官网发布资产核对完成")

# ========================================================================
# 步骤2：先放置安装包和页面资源，再切换首页
# 数据源：已通过摘要校验的暂存文件与旧页面备份。
# 操作：1) 首页最后原子替换；2) 失败时只恢复本次改动的入口文件。
# ========================================================================
logger.info("开始发布官网与双平台下载")
changed = []
try:
    # 2.1 版本资源先发布，相同内容可以复用，保留已有旧版本下载。
    for item in manifest["files"]:
        if item["destination"] in mutable:
            continue
        destination = website / item["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        if not destination.exists():
            replace_file(release / "payload" / item["source"], destination)
        assert digest(destination) == item["sha256"]
    # 2.2 两个平台安装包完整就位后，分别原子切换清单，首页最后发布。
    for name in ["downloads/updates/win/latest.yml", "downloads/updates/linux/x64/latest-linux.yml", "index.html"]:
        item = next(item for item in manifest["files"] if item["destination"] == name)
        destination = website / name
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        expected = manifest["baseline"][name]
        assert (digest(destination) if destination.exists() else None) == expected
        replace_file(release / "payload" / item["source"], destination)
        changed.append(name)
    # 2.3 本机 HTTP 入口也必须能读取新的首页和全部静态文件。
    for item in manifest["files"]:
        request = urllib.request.Request("http://127.0.0.1/" + item["destination"], method="HEAD")
        with urllib.request.urlopen(request, timeout=15) as response:
            assert response.status == 200, item["destination"]
            assert int(response.headers["Content-Length"]) == item["size"], item["destination"]
    for name, expected in manifest["baseline"].items():
        if name not in mutable:
            assert digest(website / name) == expected, "保留文件发生变化：" + name
except Exception:
    for name in reversed(changed):
        current = website / name
        item = next(item for item in manifest["files"] if item["destination"] == name)
        if not current.exists() or digest(current) != item["sha256"]:
            continue
        previous = release / "previous" / name
        if previous.exists():
            replace_file(previous, current)
        else:
            current.unlink()
    raise
result = {"deployed": True, "version": "0.80.23", "url": "https://117.72.245.101/", "backup": str(release), "backendRestarted": False}
(release / "published.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
logger.info("官网与双平台下载发布完成")
print(json.dumps(result, ensure_ascii=False), flush=True)
