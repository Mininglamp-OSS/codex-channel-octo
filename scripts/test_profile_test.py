import fcntl
from unittest.mock import patch
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('profile', Path(__file__).with_name('test_profile.py'))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def test_reserved_and_traversal_names(self):
        for name in ['production', 'prod', 'default', '../test-a', 'test-a/../b', 'test-a..b']:
            with self.assertRaises(ValueError):
                profile.Profile(self.base, name)

    def test_shared_home_and_overlap_refused(self):
        for base in [Path.home(), Path.home() / '.codex', Path.home() / '.codex-channel-octo']:
            with self.assertRaises(ValueError):
                profile.Profile(base, 'test-a')
        with self.assertRaises(ValueError):
            profile.Profile(self.base, 'test-a', anchors=[self.base / 'test-a' / 'data'])

    def test_two_profiles_and_modes(self):
        a = profile.Profile(self.base, 'test-a')
        b = profile.Profile(self.base, 'test-b')
        with a, b:
            self.assertNotEqual(a.root, b.root)
            a.write('secret.json', b'{"token":"fixture"}')
            self.assertEqual(a.read('secret.json'), b'{"token":"fixture"}')
            self.assertEqual((a.root / 'secret.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(a.root.stat().st_mode & 0o777, 0o700)
            self.assertFalse((b.root / 'secret.json').exists())

    def test_symlink_and_hardlink_secret_refused(self):
        with profile.Profile(self.base, 'test-a') as p:
            p.write('real', b'secret')
            os.symlink(p.root / 'real', p.root / 'link')
            with self.assertRaises((OSError, ValueError)):
                p.read('link')
            os.link(p.root / 'real', p.root / 'hard')
            with self.assertRaises(ValueError):
                p.read('hard')

    def test_open_directory_anchor_defeats_parent_swap(self):
        with profile.Profile(self.base, 'test-a') as p:
            p.write('secret', b'old')
            old = self.base / 'moved'
            p.root.rename(old)
            p.root.mkdir(mode=0o700)
            (p.root / 'secret').write_text('attacker')
            # Reading stays anchored to the already-open directory, never the replacement.
            self.assertEqual(p.read('secret'), b'old')
            with self.assertRaises(ValueError):
                p.assert_identity()

    def test_permissions_and_stale_pid_are_fail_closed(self):
        with profile.Profile(self.base, 'test-a') as p:
            p.write('secret', b'secret')
            (p.root / 'secret').chmod(0o644)
            with self.assertRaises(ValueError):
                p.read('secret')
            p.write('state.json', json.dumps({'pid': os.getpid(), 'nonce': 'stale'}).encode())
            self.assertEqual(profile.control(p, 'status')['state'], 'stale')
            # A PID alone can never authorize a signal.
            self.assertEqual(profile.control(p, 'stop')['state'], 'stale')

    def test_ancestor_symlink_refused(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            profile.Profile(alias, 'test-a').__enter__()

    def test_per_bot_paths_are_private_and_credential_overrides_are_refused(self):
        with profile.Profile(self.base, 'test-a') as p:
            p.directory('config')
            p.write('bot.json', b'{"botToken":"fixture-only"}')
            p.write('gateway.json', json.dumps({'apiUrl': 'https://example.com',
                'bots': [{'id': 'bot-a', 'credentialFile': 'bot.json'}]}).encode())
            profile.prepare_gateway(p)
            for name in ['data', 'workspace', 'memory', 'codex-home']:
                path = p.root / 'config' / 'bot-a' / name
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertEqual((p.root / 'config' / 'bot-a' / 'config.json').stat().st_mode & 0o777, 0o600)
            p.write('bot.json', b'{"botToken":"fixture-only","sdk":{"codexHome":"/shared"}}')
            with self.assertRaises(ValueError):
                profile.prepare_gateway(p)

    def test_losing_start_never_mutates_profile_or_probes_executable(self):
        with profile.Profile(self.base, 'test-a') as p:
            p.directory('config')
            p.write('bot.json', b'{"botToken":"fixture-only"}')
            p.write('gateway.json', json.dumps({'apiUrl': 'https://example.com',
                'bots': [{'id': 'bot-a', 'credentialFile': 'bot.json'}]}).encode())
            profile.prepare_gateway(p)
            lock = os.open(p.root / 'owner.lock', os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = {str(f.relative_to(p.root)): f.read_bytes() for f in p.root.rglob('*') if f.is_file()}
            try:
                with patch.object(profile, 'validate_executable') as validate, patch.object(profile, 'prepare_gateway') as prepare:
                    with self.assertRaisesRegex(ValueError, 'already locked'):
                        profile.run(p, '/not-executed', 'digest', 1, '/not-executed.js', '/not-executed-node')
                    validate.assert_not_called()
                    prepare.assert_not_called()
                after = {str(f.relative_to(p.root)): f.read_bytes() for f in p.root.rglob('*') if f.is_file()}
                self.assertEqual(before, after)
                self.assertEqual({str(f.relative_to(p.root)) for f in p.root.iterdir()}, {'config', 'bot.json', 'gateway.json', 'owner.lock'})
            finally:
                os.close(lock)

    def test_failed_owned_start_releases_the_lock(self):
        with profile.Profile(self.base, 'test-a') as p:
            with patch.object(profile, 'run_owned', side_effect=ValueError('fixture failure')):
                for _ in range(2):
                    with self.assertRaisesRegex(ValueError, 'fixture failure'):
                        profile.run(p, '/not-executed', 'digest', 1)


if __name__ == '__main__':
    unittest.main()
