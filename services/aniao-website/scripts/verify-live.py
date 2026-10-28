import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser(description="核对线上官网、完整安装包和保留接口")
parser.add_argument("--manifest", required=True, type=pathlib.Path)
arguments = parser.parse_args()
manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
base = "https://117.72.245.101/"
report = {"url": base, "assets": [], "downloads": [], "preserved": []}


def request(path, method="GET", headers=None):
    return urllib.request.urlopen(urllib.request.Request(base + path, method=method, headers=headers or {}), timeout=45)


# ========================================================================
# 步骤1：验证公网 HTTPS 页面与兼容入口
# 数据源：真实公网 HTTP/HTTPS 响应和发布前文件快照摘要。
# 操作：1) 正常校验证书；2) 后台和旧更新源保持可访问。
# ========================================================================
print("开始核对线上官网与兼容入口", flush=True)
for item in manifest["files"]:
    # 1.1 静态页面和更新清单逐字节比对，安装包先查大小和分段下载。
    name = item["destination"]
    with request(name, method="HEAD") as response:
        assert response.status == 200, name
        assert int(response.headers["Content-Length"]) == item["size"], name
    if name.endswith((".exe", ".deb")):
        with request(name, headers={"Range": "bytes=0-63"}) as response:
            assert response.status == 206, name
            assert response.headers["Content-Range"] == "bytes 0-63/" + str(item["size"]), name
            prefix = response.read()
            assert len(prefix) == 64
            assert prefix.startswith(b"MZ" if name.endswith(".exe") else b"!<arch>\n"), name
        continue
    with request(name) as response:
        assert hashlib.sha256(response.read()).hexdigest() == item["sha256"], name
    report["assets"].append(name)
for name, expected in manifest["baseline"].items():
    if name in {"index.html", "downloads/updates/linux/x64/latest-linux.yml", "downloads/updates/win/latest.yml"} or expected is None:
        continue
    with request(name) as response:
        assert hashlib.sha256(response.read()).hexdigest() == expected, name
    report["preserved"].append(name)
with request("admin/feedback/") as response:
    assert response.status == 200
with request("api/health") as response:
    assert json.loads(response.read())["status"] == "ok"
try:
    request("api/admin/feedback")
    raise AssertionError("反馈管理接口未要求认证")
except urllib.error.HTTPError as error:
    assert error.code == 401
with request("downloads/Aniao-Harness-Setup-0.80.22.exe", method="HEAD") as response:
    assert response.status == 200
with urllib.request.urlopen("http://117.72.245.101/", timeout=30) as response:
    assert response.status == 200
    assert hashlib.sha256(response.read()).hexdigest() == next(item["sha256"] for item in manifest["files"] if item["destination"] == "index.html")
print("线上官网与兼容入口核对完成", flush=True)

# ========================================================================
# 步骤2：从公网完整下载两个安装包并验证摘要
# 数据源：用户实际下载 URL 与本地已验收的 SHA-256。
# 操作：1) 流式计算摘要不占用大块内存；2) 核对完整长度，拒绝截断文件。
# ========================================================================
print("开始完整验证公网双平台安装包", flush=True)
packages = [item for item in manifest["files"] if item["destination"].startswith("downloads/Aniao-") and item["destination"].endswith((".exe", ".deb"))]
parts = arguments.manifest.parent / ("verify-parts-" + uuid.uuid4().hex)
parts.mkdir()


def download_part(item, index, start, end):
    name = item["destination"]
    target = parts / (pathlib.PurePosixPath(name).name + ".part" + str(index))
    size = 0
    with request(name, headers={"Range": f"bytes={start}-{end}"}) as response, target.open("wb") as stream:
        assert response.status == 206, name
        assert response.headers["Content-Range"] == f"bytes {start}-{end}/" + str(item["size"])
        while chunk := response.read(1024 * 1024):
            stream.write(chunk)
            size += len(chunk)
    assert size == end - start + 1
    print(f"已核对分段：{pathlib.PurePosixPath(name).name} {index + 1}/4", flush=True)


# 2.1 四段并发读取同一公网 URL，避免单连接吞吐限制；每段核对响应范围和长度。
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    futures = []
    for item in packages:
        for index in range(4):
            start = item["size"] * index // 4
            end = item["size"] * (index + 1) // 4 - 1
            futures.append(executor.submit(download_part, item, index, start, end))
    for future in concurrent.futures.as_completed(futures):
        future.result()
for item in packages:
    # 2.2 按原始顺序读取全部分段，校验完整安装包而非只校验片段。
    name = item["destination"]
    digest = hashlib.sha256()
    size = 0
    for index in range(4):
        with (parts / (pathlib.PurePosixPath(name).name + ".part" + str(index))).open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
    assert size == item["size"], name
    assert digest.hexdigest() == item["sha256"], name
    report["downloads"].append({"url": base + name, "size": size, "sha256": digest.hexdigest()})
    print("摘要一致：" + pathlib.PurePosixPath(name).name, flush=True)
    for index in range(4):
        (parts / (pathlib.PurePosixPath(name).name + ".part" + str(index))).unlink()
parts.rmdir()
report["passed"] = True
result = arguments.manifest.parent / "live-verification.json"
result.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"passed": True, "report": str(result)}, ensure_ascii=False), flush=True)
print("公网双平台安装包完整验证结束", flush=True)
