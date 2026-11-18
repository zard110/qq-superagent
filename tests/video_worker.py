"""Exercise the actual FFmpeg pipeline with a generated video, without provider credentials."""
import base64
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

class VideoTest(unittest.TestCase):
    def test_frames_and_audio(self):
        worker = pathlib.Path(__file__).resolve().parents[1] / "sandbox" / "worker.py"
        with tempfile.TemporaryDirectory() as folder:
            clip = pathlib.Path(folder) / "sample.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=6", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-pix_fmt", "yuv420p", str(clip)], check=True)
            payload = json.dumps({"op": "video", "data": base64.b64encode(clip.read_bytes()).decode()})
            output = json.loads(subprocess.check_output([sys.executable, str(worker)], input=payload.encode()))
            self.assertGreaterEqual(len(output["frames"]), 2)
            self.assertTrue(all(base64.b64decode(frame["data"]).startswith(b"\xff\xd8") for frame in output["frames"]))
            self.assertGreater(len(base64.b64decode(output["audio"])), 1000)
            request = json.loads(payload)
            request["audioFormat"] = "opus"
            opus = json.loads(subprocess.check_output([sys.executable, str(worker)], input=json.dumps(request).encode()))
            self.assertEqual(opus["audioChunks"][0]["at"], 0)
            self.assertTrue(base64.b64decode(opus["audioChunks"][0]["data"]).startswith(b"OggS"))

if __name__ == "__main__":
    unittest.main()
