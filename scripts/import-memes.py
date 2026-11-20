"""Import ChineseBQB originals and their upstream captions. Optional Chinese OCR via rapidocr."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

PACKS = {"015": "熊猫头", "031": "沙雕企鹅", "035": "猫和老鼠", "049": "猫咪日常"}
MIMES = {".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

def get(url):
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers={"User-Agent": "qq-superagent-meme-import"}), timeout=24) as r:
                return r.read()
        except OSError:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)

def publish(path, data):
    temp = path.with_suffix(".new")
    temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--workers", type=int, default=10)
    args = parser.parse_args()
    root = args.directory
    files = root / "files"
    files.mkdir(parents=True, exist_ok=True)
    tree = json.loads(get("https://api.github.com/repos/zhaoolee/ChineseBQB/git/trees/master?recursive=1"))
    if tree.get("truncated"):
        raise RuntimeError("上游目录不完整")
    entries = [v for v in tree["tree"] if v["path"][:3] in PACKS and v["type"] == "blob"
               and Path(v["path"]).suffix.lower() in MIMES and len(v["path"].split("/")) == 2]
    def import_one(v):
        path = v["path"]
        ident = v["sha"]
        file = files / ident
        if not file.exists():
            data = get("https://raw.githubusercontent.com/zhaoolee/ChineseBQB/" + tree["sha"] + "/" + quote(path))
            if hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() != ident:
                raise ValueError("原图校验失败")
            temp = file.with_suffix("." + str(__import__("threading").get_ident()) + ".tmp")
            temp.write_bytes(data)
            os.replace(temp, file)
        title = re.sub(r"^.*?\d+[-_ ]*", "", Path(path).stem).strip("-_ ")
        return {"id":ident, "pack":path[:3], "title":title, "path":path, "mime":MIMES[Path(path).suffix.lower()]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        items = list(pool.map(import_one, entries))
    if not all(any(i["pack"] == p for i in items) for p in PACKS):
        raise ValueError("系列缺失")
    ocr_file = root / "ocr.json"
    captions = json.loads(ocr_file.read_text(encoding="utf8")) if ocr_file.exists() else {}
    def index():
        publish(root / "index.json", {"revision":tree["sha"], "items":[dict(i, text=captions.get(i["id"], "")) for i in items]})
    index()
    print("Imported", len(items), "images", flush=True)
    if args.ocr:
        from rapidocr import RapidOCR
        from PIL import Image
        import numpy as np
        engine = RapidOCR(params={"EngineConfig.onnxruntime.intra_op_num_threads":2,"EngineConfig.onnxruntime.inter_op_num_threads":1})
        for i in items:
            ident = i["id"]
            if ident in captions:
                continue
            with Image.open(files / ident) as im:
                im.thumbnail((720,720))
                result = engine(np.asarray(im.convert("RGB")))
            captions[ident] = " ".join(result.txts or [])
            if len(captions) % 25 == 0:
                publish(ocr_file, captions)
                index()
        publish(ocr_file, captions)
        index()

if __name__ == "__main__":
    main()

