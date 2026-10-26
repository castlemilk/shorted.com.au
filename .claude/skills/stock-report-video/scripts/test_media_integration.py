"""Generate synthetic signals only; no private voice, models or network required."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/ffprobe required')
class EncodedMedia(unittest.TestCase):
    def test_good_silent_and_missing_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            good = root / 'good.mp4'
            def ffmpeg(*args):
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', *map(str, args)], check=True, capture_output=True, timeout=60)
            ffmpeg('-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-af', 'pan=stereo|c0=c0|c1=c0,loudnorm=I=-16:TP=-2:LRA=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-disposition:a:0', 'default', '-shortest', good)
            silent, missing = root / 'silent.mp4', root / 'missing.mp4'
            ffmpeg('-i', good, '-c:v', 'copy', '-af', 'volume=0', '-c:a', 'aac', silent)
            ffmpeg('-i', good, '-c:v', 'copy', '-an', missing)
            script = Path(__file__).with_name('validate_video.py')
            for path, code in [(good, 0), (silent, 1), (missing, 1)]:
                with self.subTest(path=path.name):
                    result = subprocess.run([sys.executable, str(script), str(path)], capture_output=True, text=True, timeout=60)
                    self.assertEqual(result.returncode, code, result.stderr + result.stdout)
                    report = json.loads(result.stdout)
                    self.assertEqual(report['status'], 'passed' if code == 0 else 'failed')
                    self.assertEqual(report['userPlayback'], 'unconfirmed')
                    self.assertEqual(report['fullDecode'], 'passed')
