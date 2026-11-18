import base64
import json
import math
import os
import subprocess
import sys
import tempfile
import re
from pathlib import Path

def command(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=45)

def video(data, audio_format='mp3'):
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
            if audio_format == "opus":
                chunks = []
                for start in range(0, math.ceil(duration), 30):
                    raw = command("ffmpeg", "-v", "error", "-ss", str(start), "-i", path, "-t", "30", "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", "-")
                    if raw:
                        chunks.append({"at": start, "data": base64.b64encode(raw).decode()})
                return {"duration": duration, "frames": frames, "audioChunks": chunks}
            raw = command("ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", "-")
            audio = base64.b64encode(raw).decode()
        return {"duration": duration, "frames": frames, "audio": audio}

def main():
    body = json.load(sys.stdin)
    if body["op"] == "python":
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryFile() as out:
            def local(name):
                if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}', name):
                    raise ValueError('文件名无效')
                return Path(folder, name)
            for item in body.get('inputs', []):
                local(item['name']).write_bytes(base64.b64decode(item['data'], validate=True))
            wheels = []
            for item in body.get('wheels', []):
                path = local(item['name'])
                if not path.name.endswith('.whl'):
                    raise ValueError('只支持 wheel 工具包')
                path.write_bytes(base64.b64decode(item['data'], validate=True))
                wheels.append(str(path))
            library = str(Path(folder, 'packages'))
            if wheels:
                install = subprocess.run([sys.executable, '-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--no-index', '--only-binary=:all:', '--find-links', folder, '--target', library, *wheels], stdout=out, stderr=out, timeout=40)
                if install.returncode:
                    out.seek(0)
                    return {'exit': install.returncode, 'output': out.read(16000).decode(errors='replace'), 'files': []}
            launcher = 'import sys;sys.path.insert(0,' + repr(library) + ');exec(compile(' + repr(body['code']) + ',"<task>","exec"))'
            process = subprocess.run([sys.executable, "-I", "-c", launcher], stdout=out, stderr=out, timeout=30, cwd=folder)
            files = []
            if process.returncode == 0:
                for name in body.get('outputs', []):
                    path = local(name)
                    if path.is_symlink() or path.resolve().parent != Path(folder) or not path.is_file():
                        raise ValueError('任务未生成指定输出文件')
                    if path.stat().st_size > 10_000_000:
                        raise ValueError('输出文件超过 10 MB')
                    files.append({'name': name, 'data': base64.b64encode(path.read_bytes()).decode()})
            out.seek(0)
            return {"exit": process.returncode, "output": out.read(16000).decode(errors="replace"), 'files': files}
    if body['op'] == 'audio':
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'source')
            with open(path, 'wb') as output:
                output.write(base64.b64decode(body['data'], validate=True))
            probe = json.loads(command('ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path))
            duration = float(probe['format']['duration'])
            start = float(body['start'])
            end = float(body.get('end') if body.get('end') is not None else duration)
            if not any(s['codec_type'] == 'audio' for s in probe['streams']):
                raise ValueError('素材没有可用音轨')
            if not all(math.isfinite(v) for v in [start,end,duration]) or not 0 <= start < end <= duration + .1:
                raise ValueError('剪辑时间超出音频时长（' + str(round(duration,2)) + ' 秒），可能只是试听片段')
            if end-start > 600:
                raise ValueError('单次音频输出最多十分钟')
            raw = command('ffmpeg','-v','error','-ss',str(start),'-i',path,'-t',str(end-start),'-vn','-c:a','libmp3lame','-b:a','128k','-f','mp3','-')
            return {'data':base64.b64encode(raw).decode(),'end':end,'duration':end-start}
    if body["op"] == "video":
        return video(body["data"], body.get("audioFormat", "mp3"))
    raise ValueError("未知操作")

if __name__ == "__main__":
    try:
        result = main()
    except subprocess.CalledProcessError:
        result = {'error': '媒体解码或转码失败，资源可能不是可播放音频/视频'}
    except subprocess.TimeoutExpired:
        result = {'error': '沙箱执行超时'}
    except Exception as error:
        result = {'error': str(error)}
    print(json.dumps(result, ensure_ascii=False))
