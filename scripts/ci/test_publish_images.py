import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest

spec = importlib.util.spec_from_file_location('publish_images', Path(__file__).with_name('publish-images.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
D = 'sha256:' + 'a' * 64
E = 'sha256:' + 'b' * 64
TRANSIENT = '#158 ERROR: failed to push registry.test/shorts:main-abc: failed to authorize: DeadlineExceeded: context deadline exceeded\nERROR: target shorts: failed to solve: DeadlineExceeded: context deadline exceeded'

class Fake:
    def __init__(self, outcomes=(0,), inspection=(0, json.dumps({'digest': D})), bad_metadata=False):
        self.calls=[]; self.outcomes=list(outcomes); self.inspection=inspection; self.bad_metadata=bad_metadata
    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if '--print' in args:
            return 0, json.dumps({'target': {'shorts': {'tags': ['registry.test/shorts:main-abc', 'registry.test/shorts:latest']}}})
        if 'inspect' in args:
            return self.inspection
        result=self.outcomes.pop(0)
        if not result:
            path=Path(args[args.index('--metadata-file')+1])
            path.write_text(json.dumps({'shorts': {'containerimage.digest': E if self.bad_metadata else D}}))
        return result, TRANSIENT if result else 'build done'
    def builds(self): return [a for a,k in self.calls if '--push' in a]

class Tests(unittest.TestCase):
    def test_real_command_success_and_timeout(self):
        code, text = m.command([sys.executable, '-c', 'print("ok")'], timeout=2)
        self.assertEqual((code,text.strip()),(0,'ok'))
        with self.assertRaises(m.PublishError):
            m.command([sys.executable,'-c','import time; time.sleep(5)'],timeout=.1)
    def test_success_verifies_remote_digest(self):
        f=Fake();m.publish('registry.test','main-abc',f);self.assertEqual(len(f.builds()),1)
        self.assertTrue(any('inspect' in a for a,k in f.calls))
    def test_transient_reconciles_before_one_cached_retry(self):
        f=Fake((1,0));wait=[];m.publish('registry.test','main-abc',f,wait.append)
        self.assertEqual(len(f.builds()),2);self.assertEqual(wait,[10]);self.assertTrue(all('--no-cache' not in a for a in f.builds()))
        commands=[a for a,k in f.calls];self.assertIn('inspect',commands[2]);self.assertEqual(commands[1][commands[1].index('--builder')+1],'shorted-builder')
    def test_retry_is_bounded(self):
        f=Fake((1,1));
        with self.assertRaises(m.PublishError):m.publish('registry.test','main-abc',f,lambda _:None)
        self.assertEqual(len(f.builds()),2)
    def test_missing_manifest_is_distinct_from_denied(self):
        self.assertIsNone(m.inspect_tag('x',lambda *a,**k:(1,'manifest unknown')))
        for error in ['permission denied','context deadline exceeded','unauthorized: manifest unknown']:
            with self.assertRaises(m.PublishError):m.inspect_tag('x',lambda *a,**k:(1,error))
    def test_inconclusive_inspection_prevents_retry(self):
        f=Fake((1,0),inspection=(1,'context deadline exceeded'))
        with self.assertRaises(m.PublishError):m.publish('registry.test','main-abc',f,lambda _:None)
        self.assertEqual(len(f.builds()),1)
    def test_permission_compile_and_disk_failures_are_not_retried(self):
        for x in ['permission denied','unauthorized','invalid_grant','no space left on device']:
            self.assertFalse(m.retryable(TRANSIENT+'\n'+x))
        self.assertFalse(m.retryable(TRANSIENT+'\n#14 ERROR: compiler failed'))
        self.assertFalse(m.retryable('ERROR: target shorts: compile failure'))
    def test_observed_push_timeout_is_retryable(self):self.assertTrue(m.retryable(TRANSIENT))
    def test_mixed_unknown_push_error_prevents_retry(self):
        self.assertFalse(m.retryable(TRANSIENT+'\n#22 ERROR: failed to push registry.test/other: unknown publishing problem'))
    def test_denied_other_target_prevents_retry(self):
        self.assertFalse(m.retryable(TRANSIENT+'\n#22 ERROR: failed to push registry.test/other: denied: requested access to the resource is denied'))
    def test_truncated_diagnostics_never_authorize_retry(self):
        script='import sys; print("permission denied"); print("x"*70000); print('+repr(TRANSIENT)+'); sys.exit(1)'
        code, output=m.command([sys.executable,'-c',script],timeout=2)
        self.assertEqual(code,1)
        self.assertLess(len(output),66000)
        self.assertIn(m.TRUNCATED,output)
        self.assertFalse(m.retryable(output))
    def test_mixed_missing_and_transport_error_is_inconclusive(self):
        with self.assertRaises(m.PublishError):
            m.inspect_tag('x',lambda *a,**k:(1,'manifest unknown\nTLS handshake timeout'))
    def test_wrong_digest_never_passes(self):
        with self.assertRaises(m.PublishError):m.publish('registry.test','main-abc',Fake(bad_metadata=True))
    def test_rejects_missing_and_mutable_release_tag(self):
        for tag in ['', 'latest', 'main abc']:
            with self.assertRaises(m.PublishError):m.publish('registry.test',tag,Fake())
    def test_rejects_plan_without_exact_tag(self):
        with self.assertRaises(m.PublishError):m.targets_from_plan({'target':{'shorts':{'tags':['registry.test/shorts:latest']}}},'registry.test','main-abc')
    def test_rejects_invalid_remote_digest(self):
        for value in ['{}','not json',json.dumps({'digest':'sha256:abc'})]:
            with self.assertRaises(m.PublishError):m.inspect_tag('x',lambda *a,**k:(0,value))
    def test_no_credentials_or_destructive_commands(self):
        f=Fake((1,0));m.publish('registry.test','main-abc',f,lambda _:None)
        for args,kwargs in f.calls:
            self.assertEqual(args[0],'docker');self.assertNotIn('login',args);self.assertNotIn('prune',args);self.assertNotIn('rm',args)
            self.assertLessEqual(kwargs['timeout'],3600)

if __name__ == '__main__':unittest.main()
