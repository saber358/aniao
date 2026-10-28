import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import pathlib
import posixpath
import shlex
import sys

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser(description="发布已验收的 Aniao 静态官网与双平台安装包")
parser.add_argument("--auth-helper", required=True, type=pathlib.Path, help="提供 connect() 的现有 SSH 认证模块，密钥不写入发布清单")
arguments = parser.parse_args()
source = pathlib.Path(__file__).resolve().parents[1]
repository = source.parents[1]
installers = repository / "packages/gui/artifacts/publish-0.80.23-20261028/installers"
feed = repository / "packages/gui/artifacts/publish-0.80.23-20261028/linux/latest-linux.yml"
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
directory = source / "artifacts" / ("deploy-" + stamp)
remote = "/var/lib/aniao-harness/website-" + stamp
files = {}
for name in ["index.html", "site-v2.css", "site-v1.js", "assets/aniao-hero-v1.webp", "assets/workspace-v1.webp", "assets/icons.svg", "assets/favicon.svg", "assets/lucide-LICENSE.txt"]:
    files[name] = source / "public" / name
for name in ["Aniao-Harness-0.80.23-windows-x64-setup.exe", "Aniao-Harness-0.80.23-linux-amd64.deb"]:
    files["downloads/" + name] = installers / name
files["downloads/aniao-0.80.23-SHA256SUMS.txt"] = installers / "SHA256SUMS.txt"
files["downloads/updates/linux/x64/latest-linux.yml"] = feed
files["downloads/updates/win/latest.yml"] = installers / "latest.yml"
files["downloads/updates/win/Aniao-Harness-0.80.23-windows-x64-setup.exe.blockmap"] = installers / "Aniao-Harness-0.80.23-windows-x64-setup.exe.blockmap"
expected_packages = {
    "Aniao-Harness-0.80.23-windows-x64-setup.exe": "706816029e5df81c4ac3819ea1141ad4f311941e69c7171bbe43ef47bdc85008",
    "Aniao-Harness-0.80.23-linux-amd64.deb": "660a1751c1d46de938e4dedb50d49e60f5bfed21ba85d1646c77320f35a3f97b",
}


def digest(path, algorithm="sha256"):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm)


# ========================================================================
# 步骤1：生成有限范围的发布清单并验证本地安装包
# 数据源：官网 public、已验收的安装包和既有 SSH 连接助手。
# 操作：1) 不上传原始素材和用户数据；2) 对下载包与更新元数据做摘要核对。
# ========================================================================
print("开始准备官网发布清单", flush=True)
directory.mkdir(parents=True)
manifest = {"version": "0.80.23", "files": [], "baseline": {}}
for name, path in files.items():
    # 1.1 先校验所有本地输入，再连接服务器上传。
    checksum = digest(path).hexdigest()
    if path.name in expected_packages:
        assert checksum == expected_packages[path.name], path.name
    manifest["files"].append({"source": name, "destination": name, "size": path.stat().st_size, "sha256": checksum})
linux = next(item for item in manifest["files"] if item["destination"].endswith(".deb"))
linux_feed = dict(linux)
linux_feed["destination"] = "downloads/updates/linux/x64/" + pathlib.PurePosixPath(linux["source"]).name
manifest["files"].append(linux_feed)
windows = next(item for item in manifest["files"] if item["destination"].endswith(".exe"))
windows_feed = dict(windows)
windows_feed["destination"] = "downloads/updates/win/" + pathlib.PurePosixPath(windows["source"]).name
manifest["files"].append(windows_feed)
sha512 = base64.b64encode(digest(files[linux["source"]], "sha512").digest()).decode("ascii")
assert "sha512: " + sha512 in feed.read_text(encoding="utf-8")
assert "size: " + str(linux["size"]) in feed.read_text(encoding="utf-8")
windows_sha512 = base64.b64encode(digest(files[windows["source"]], "sha512").digest()).decode("ascii")
windows_metadata = files["downloads/updates/win/latest.yml"].read_text(encoding="utf-8")
assert "sha512: " + windows_sha512 in windows_metadata
assert "size: " + str(windows["size"]) in windows_metadata
checksums = files["downloads/aniao-0.80.23-SHA256SUMS.txt"].read_text(encoding="utf-8")
for name, checksum in expected_packages.items():
    assert checksum + "  " + name in checksums
spec = importlib.util.spec_from_file_location("server_auth", arguments.auth_helper.resolve())
authentication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(authentication)
print("官网发布清单准备完成", flush=True)

# ========================================================================
# 步骤2：上传暂存文件，再运行摘要校验和原子发布
# 数据源：范围固定的发布清单与现有官网文件快照。
# 操作：1) 备份旧首页和 Windows 更新源；2) 上传完成才允许激活新首页。
# ========================================================================
print("开始上传官网和双平台安装包", flush=True)
client = authentication.connect()
try:
    sftp = client.open_sftp()
    # 2.1 把保留文件摘要写入清单，服务器激活前再次核对。
    for name in ["index.html", "styles.css", "main.js", "downloads/updates/win/latest.yml", "downloads/updates/linux/x64/latest-linux.yml", "admin/feedback/index.html", "admin/feedback/app.js", "admin/feedback/styles.css"]:
        try:
            with sftp.open("/var/www/html/" + name, "rb") as stream:
                content = stream.read()
            manifest["baseline"][name] = hashlib.sha256(content).hexdigest()
            backup = directory / "previous" / name
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(content)
        except FileNotFoundError:
            manifest["baseline"][name] = None
    known = {"/var/lib/aniao-harness"}
    for relative, local in files.items():
        # 2.2 大安装包先传到隔离暂存目录，失败不会暴露半个下载文件。
        target = remote + "/payload/" + relative
        folders = []
        folder = posixpath.dirname(target)
        while folder not in known:
            folders.append(folder)
            folder = posixpath.dirname(folder)
        for folder in reversed(folders):
            try:
                sftp.mkdir(folder, mode=0o755)
            except OSError:
                sftp.stat(folder)
            known.add(folder)
        print("上传：" + relative, flush=True)
        last_percentage = [-1]

        def report_progress(transferred, total):
            percentage = int(transferred * 10 / total) * 10
            if total > 1024 * 1024 and percentage > last_percentage[0]:
                last_percentage[0] = percentage
                print("  " + str(percentage) + "%", flush=True)

        sftp.put(str(local), target, confirm=True, callback=report_progress)
    manifest_path = directory / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sftp.put(str(manifest_path), remote + "/manifest.json")
    sftp.put(str(source / "deploy/activate.py"), remote + "/activate.py")
    sftp.close()
    # 2.3 只有服务端所有输入验证通过，才切换首页。
    _, output, errors = client.exec_command("python3 " + shlex.quote(remote + "/activate.py") + " 2>&1", timeout=60)
    for line in output:
        print(line.rstrip(), flush=True)
    error = errors.read().decode("utf-8")
    if output.channel.recv_exit_status() != 0:
        raise RuntimeError(error or "官网发布失败，旧首页已保留或恢复")
    (directory / "deployment.json").write_text(json.dumps({"remote": remote, "url": "https://117.72.245.101/", "manifest": str(manifest_path)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
finally:
    client.close()
print("官网和双平台下载上传结束", flush=True)
