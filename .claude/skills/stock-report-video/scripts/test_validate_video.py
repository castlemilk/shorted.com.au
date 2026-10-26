import copy
import unittest
from validate_video import assess, number

PROBE = {'streams': [
    {'codec_type': 'video', 'codec_name': 'h264', 'pix_fmt': 'yuv420p', 'duration': '10'},
    {'codec_type': 'audio', 'codec_name': 'aac', 'profile': 'LC', 'channels': 2, 'sample_rate': '48000', 'duration': '10', 'disposition': {'default': 1}},
]}
LEVELS = {'input_i': '-16', 'input_tp': '-2'}


class MediaGate(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(assess(PROBE, LEVELS), [])

    def test_silent_and_missing_levels(self):
        for levels in ({}, {'input_i': '-inf', 'input_tp': '-inf'}):
            self.assertTrue(assess(PROBE, levels))

    def test_no_audio(self):
        self.assertTrue(assess({'streams': PROBE['streams'][:1]}, {}))

    def test_duplicate_audio(self):
        p = copy.deepcopy(PROBE)
        p['streams'].append(p['streams'][1])
        self.assertTrue(assess(p, LEVELS))

    def test_stream_requirements(self):
        for key, value in [('duration', '2'), ('duration', 'N/A'), ('channels', 1), ('sample_rate', '22050'), ('codec_name', 'mp3'), ('profile', 'HE-AAC'), ('disposition', {'default': 0})]:
            with self.subTest(key=key, value=value):
                p = copy.deepcopy(PROBE)
                p['streams'][1][key] = value
                self.assertTrue(assess(p, LEVELS))

    def test_loudness_and_peak(self):
        for levels in ({'input_i': '-16', 'input_tp': '0.2'}, {'input_i': '-40', 'input_tp': '-2'}, {'input_i': '-8', 'input_tp': '-2'}):
            self.assertTrue(assess(PROBE, levels))

    def test_nonfinite(self):
        for value in ('nan', 'inf', '-inf', None, 'N/A'):
            self.assertIsNone(number(value))

    def test_configurable_targets(self):
        self.assertEqual(assess(PROBE, {'input_i': '-20', 'input_tp': '-3'}, min_lufs=-23), [])


if __name__ == '__main__':
    unittest.main()
