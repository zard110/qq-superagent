import base64
import json
import math
import os
import subprocess
import sys
import tempfile

def command(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=45)

def video(data):
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "clip")
        with open(path, "wb") as output:
            output.write(base64.b64decode(data, validate=True))
        probe = json.loads(command("ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path))
        duration = float(probe["format"]["duration"])
        if not 0 < duration <= 600:
            raise ValueError("视频支持最长十分钟")
        frames = []
        count = min(12, max(1, math.ceil(duration)))
        for index in range(count):
            at = round(index * duration / count, 2)
            frame = command("ffmpeg", "-v", "error", "-ss", str(at), "-i", path, "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-")
            if frame:
                frames.append({"at": at, "data": base64.b64encode(frame).decode()})
        audio = None
        if any(s["codec_type"] == "audio" for s in probe["streams"]):
            raw = command("ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", "-")
            audio = base64.b64encode(raw).decode()
        return {"duration": duration, "frames": frames, "audio": audio}

def main():
    body = json.load(sys.stdin)
    if body["op"] == "python":
        with tempfile.TemporaryFile() as out:
            process = subprocess.run([sys.executable, "-I", "-c", body["code"]], stdout=out, stderr=out, timeout=15, cwd=tempfile.gettempdir())
            out.seek(0)
            return {"exit": process.returncode, "output": out.read(16000).decode(errors="replace")}
    if body["op"] == "video":
        return video(body["data"])
    raise ValueError("未知操作")

if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False))
