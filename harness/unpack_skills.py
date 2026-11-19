"""Stage public skill directories in the current group task. Never run repository code."""
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
from zipfile import ZipFile


def stage(blob):
    with ZipFile(io.BytesIO(blob)) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(e.file_size for e in entries) > 128 * 1024 * 1024:
            raise ValueError("技能仓库超过解压限制")
        paths = {}
        for entry in entries:
            name = entry.filename.rstrip("/")
            path = PurePosixPath(name)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if (not path.parts or path.is_absolute() or "\\" in name or ".." in path.parts
                    or str(path) != name or ":" in name or path in paths
                    or mode not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("压缩包含无效路径或特殊文件")
            paths[path] = entry
        dirs = [p.parent for p in paths if p.name == "SKILL.md" and len(p.parts) > 1]
        standard = [p for p in dirs if p.parts[1:2] == ("skills",)]
        dirs = sorted(standard or dirs)
        if not dirs:
            raise ValueError("该仓库没有 SKILL.md")
        work = Path(tempfile.mkdtemp(prefix="github-skills-", dir="."))
        try:
            for path, entry in paths.items():
                if entry.is_dir() or not (any(d in path.parents for d in dirs)
                        or (len(path.parts) == 2 and path.name in ("LICENSE", "NOTICE"))):
                    continue
                target = work.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as src, target.open("xb") as dest:
                    shutil.copyfileobj(src, dest)
            staged = []
            for directory in dirs:
                source = work.joinpath(*directory.parts)
                for notice in ("LICENSE", "NOTICE"):
                    license_path = work / directory.parts[0] / notice
                    if license_path.is_file() and not (source / notice).exists():
                        shutil.copyfile(license_path, source / notice)
                if len(directory.parts) == 1:
                    header = (source / "SKILL.md").read_text("utf-8").split("---", 2)
                    match = re.search(r"""^name:\s*['"]?([a-z0-9]+(?:-[a-z0-9]+)*)['"]?\s*$""",
                                      header[1] if len(header) == 3 else "", re.MULTILINE)
                    if match and source.name != match.group(1):
                        source = source.rename(work / match.group(1))
                staged.append(str(source))
            return staged
        except BaseException:
            shutil.rmtree(work)
            raise


if __name__ == "__main__":
    print(json.dumps({"directories": stage(sys.stdin.buffer.read())}, ensure_ascii=False))
