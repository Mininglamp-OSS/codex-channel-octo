#!/usr/bin/env python3
"""Bounded foreground ENV-02 launcher. No detached work or PID-based signalling."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def overlap(a, b):
    return a == b or a in b.parents or b in a.parents


def open_directory(path):
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Absolute canonical directory required')
    fd = os.open('/', DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def private(st, mode):
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode:
        raise ValueError('Protected path has incorrect owner or permissions')


class Profile:
    def __init__(self, base, name, anchors=()):
        base = Path(base)
        if not re.fullmatch(r'test-[a-z0-9]+(?:-[a-z0-9]+)*', name):
            raise ValueError('Profile name must be test-<slug>')
        if not base.is_absolute() or '..' in base.parts or base == Path.home():
            raise ValueError('Shared home or noncanonical base refused')
        self.root = base / name
        trusted = [Path.home() / '.codex', Path.home() / '.codex-channel-octo', Path.cwd()]
        if os.getenv('CODEX_HOME'):
            trusted.append(Path(os.environ['CODEX_HOME']))
        if any(overlap(self.root, Path(p).resolve()) for p in [*trusted, *anchors]):
            raise ValueError('Profile overlaps a shared home or trust anchor')
        self.fd = None

    def __enter__(self):
        parent = open_directory(self.root.parent)
        try:
            private(os.fstat(parent), 0o700)
            try:
                os.mkdir(self.root.name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
            self.fd = os.open(self.root.name, DIRECTORY, dir_fd=parent)
            private(os.fstat(self.fd), 0o700)
        except BaseException:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            raise
        finally:
            os.close(parent)
        return self

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def assert_identity(self):
        live = open_directory(self.root)
        try:
            a, b = os.fstat(self.fd), os.fstat(live)
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise ValueError('Profile directory changed during operation')
            private(b, 0o700)
        finally:
            os.close(live)

    def directory(self, name):
        self.segment(name)
        try:
            os.mkdir(name, 0o700, dir_fd=self.fd)
        except FileExistsError:
            pass
        fd = os.open(name, DIRECTORY, dir_fd=self.fd)
        try:
            private(os.fstat(fd), 0o700)
        finally:
            os.close(fd)

    @staticmethod
    def segment(name):
        if '/' in name or name in ('.', '..'):
            raise ValueError('Single protected path segment required')

    def read(self, name):
        fd = self.open_file(name)
        try:
            st = os.fstat(fd)
            with os.fdopen(os.dup(fd), 'rb') as stream:
                data = stream.read(1024 * 1024 + 1)
            after = os.fstat(fd)
            if st.st_mtime_ns != after.st_mtime_ns or st.st_size != after.st_size:
                raise ValueError('Protected file changed during read')
            return data
        finally:
            os.close(fd)

    def open_file(self, name):
        self.segment(name)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            st = os.fstat(fd)
            private(st, 0o600)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 1024 * 1024:
                raise ValueError('Protected file must be bounded, regular and unlinked')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def write(self, name, data):
        self.segment(name)
        temporary = '.write-' + secrets.token_hex(12)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass


def control(profile, operation):
    profile.assert_identity()
    try:
        state = json.loads(profile.read('state.json'))
    except FileNotFoundError:
        return {'state': 'stopped'}
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(2)
    try:
        client.connect(str(profile.root / 'control.sock'))
        client.sendall(json.dumps({'operation': operation, 'nonce': state['nonce']}).encode())
        return json.loads(client.recv(4096))
    except (ConnectionRefusedError, FileNotFoundError):
        return {'state': 'stale'}
    finally:
        client.close()


def validate_executable(path, expected_hash):
    path = Path(path)
    parent = open_directory(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
                raise ValueError('Pinned executable must be regular and not writable by others')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                hasher = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    hasher.update(block)
                digest = hasher.hexdigest()
            if digest != expected_hash:
                raise ValueError('Pinned executable checksum mismatch')
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    return str(path)


def prepare_gateway(profile):
    manifest = json.loads(profile.read('gateway.json'))
    from urllib.parse import urlparse
    url = urlparse(manifest['apiUrl'])
    if url.username or url.password or url.query or url.fragment or not url.hostname or url.scheme not in ('http', 'https'):
        raise ValueError('Unsafe gateway API URL')
    if url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Remote gateway requires HTTPS')
    config_fd = os.open('config', DIRECTORY, dir_fd=profile.fd)
    config = Profile.__new__(Profile)
    config.fd = config_fd
    config.root = profile.root / 'config'
    try:
        bots = []
        for item in manifest.get('bots', []):
            bot_id = item['id']
            if not re.fullmatch(r'bot-[a-z0-9]+(?:-[a-z0-9]+)*', bot_id) or any(b['id'] == bot_id for b in bots):
                raise ValueError('Invalid/duplicate test bot ID')
            credential = json.loads(profile.read(item['credentialFile']))
            if set(credential) != {'botToken'} or not isinstance(credential['botToken'], str) or not credential['botToken']:
                raise ValueError('Credential file must contain only botToken')
            config.directory(bot_id)
            bot = Profile.__new__(Profile)
            bot.fd = os.open(bot_id, DIRECTORY, dir_fd=config.fd)
            bot.root = config.root / bot_id
            try:
                for directory in ['data', 'workspace', 'memory', 'codex-home']:
                    bot.directory(directory)
                bot.write('config.json', json.dumps(credential).encode())
            finally:
                os.close(bot.fd)
            bots.append({'id': bot_id})
        config.write('config.json', json.dumps({'apiUrl': manifest['apiUrl'], 'bots': bots,
            'sdk': {'approvalPolicy': 'never', 'sandboxMode': 'read-only'}}).encode())
    finally:
        os.close(config_fd)


def run(profile, executable, digest, seconds, gateway_entry=None, node=None):
    if not 1 <= seconds <= 300:
        raise ValueError('Run duration must be 1..300 seconds')
    if control(profile, 'status')['state'] not in ('stopped', 'stale'):
        raise ValueError('Profile already has an owner')
    profile.assert_identity()
    for name in ['home', 'codex-home', 'config', 'data', 'cwd', 'logs', 'bots']:
        profile.directory(name)
    env = {k: os.environ[k] for k in ['PATH', 'LANG', 'TMPDIR'] if k in os.environ}
    env.update(HOME=str(profile.root / 'home'), CODEX_HOME=str(profile.root / 'codex-home'))
    executable = validate_executable(executable, digest)
    version = subprocess.run([executable, '--version'], env=env, cwd=profile.root / 'cwd',
                             capture_output=True, timeout=5, check=True).stdout.decode().strip()
    if version != 'codex-cli 0.142.3':
        raise ValueError('Only pinned Codex 0.142.3 is accepted')
    if gateway_entry:
        entry = Path(gateway_entry)
        fd = open_directory(entry.parent)
        try:
            st = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode):
                raise ValueError('Gateway entry must be a regular file')
        finally:
            os.close(fd)
        prepare_gateway(profile)
        env.update(CODEX_OCTO_TEST_PROFILE_ROOT=str(profile.root),
                   CODEX_OCTO_TEST_CONFIG_PATH=str(profile.root / 'config' / 'config.json'),
                   CODEX_OCTO_TEST_CODEX_PATH=executable,
                   CODEX_OCTO_TEST_SHARED_HOME=str(Path.home()))
        if not node or not Path(node).is_absolute():
            raise ValueError('Explicit absolute Node executable required')
    lock = os.open('owner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=profile.fd)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(lock)
        raise ValueError('Profile already locked')
    server = socket.socket(socket.AF_UNIX)
    child = None
    selector = selectors.DefaultSelector()
    captured = []
    try:
        try:
            os.unlink('control.sock', dir_fd=profile.fd)
        except FileNotFoundError:
            pass
        server.bind(str(profile.root / 'control.sock'))
        os.chmod(profile.root / 'control.sock', 0o600)
        server.listen(4)
        selector.register(server, selectors.EVENT_READ, 'control')
        command = [str(node), str(gateway_entry)] if gateway_entry else [executable, 'app-server', '--stdio']
        guard = str(Path(__file__).with_name('guarded_child.py').resolve())
        child = subprocess.Popen([sys.executable, guard, *command], env=env,
                                 cwd=profile.root / 'cwd', stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        nonce = secrets.token_hex(32)
        state = {'pid': child.pid, 'nonce': nonce}
        profile.write('state.json', json.dumps(state).encode())
        os.set_blocking(child.stdout.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ, 'output')
        if not gateway_entry:
            child.stdin.write(b'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"env02","version":"1"}}}\n')
            child.stdin.flush()
        deadline = time.monotonic() + seconds
        stop = False
        def terminate(*_):
            nonlocal stop
            stop = True
        previous = {s: signal.signal(s, terminate) for s in [signal.SIGTERM, signal.SIGINT]}
        output_buffer = b''
        def consume(line):
            if len(captured) >= 10000:
                raise ValueError('Log record budget exceeded')
            try:
                event = json.loads(line)
            except ValueError:
                event = {}
            if 'env02ChildPid' in event:
                captured.append({'event': 'child', 'pid': event['env02ChildPid']})
                state['childPid'] = event['env02ChildPid']
                profile.write('state.json', json.dumps(state).encode())
            elif gateway_entry:
                captured.append({'event': 'gateway-log', 'sha256': hashlib.sha256(line).hexdigest()})
                if b'[codex-channel-octo] idle (no bots configured)' in line or b'[codex-channel-octo] Ready' in line:
                    captured.append({'event': 'ready', 'ok': True})
            elif event.get('id') == 1:
                if 'result' not in event:
                    raise ValueError('Initialize failed')
                captured.append({'event': 'initialize', 'ok': True, 'version': version})
        try:
            while not stop and child.poll() is None and time.monotonic() < deadline:
                profile.assert_identity()
                for key, _ in selector.select(0.1):
                    if key.data == 'output':
                        chunk = os.read(child.stdout.fileno(), 65536)
                        if not chunk:
                            stop = True
                            continue
                        output_buffer += chunk
                        if len(output_buffer) > 1024 * 1024:
                            raise ValueError('Output assembly bound exceeded')
                        while b'\n' in output_buffer:
                            line, output_buffer = output_buffer.split(b'\n', 1)
                            consume(line)
                    else:
                        connection, _ = server.accept()
                        with connection:
                            connection.settimeout(1)
                            request = json.loads(connection.recv(4096))
                            if not secrets.compare_digest(str(request.get('nonce', '')), nonce):
                                connection.sendall(b'{"state":"unauthorized"}')
                                continue
                            if request.get('operation') == 'stop':
                                stop = True
                            connection.sendall(json.dumps({'state': 'stopping' if stop else 'running',
                                'pid': child.pid, 'supervisorPid': os.getpid(),
                                'childPid': state.get('childPid'),
                                'initialized': any(e['event'] in ('initialize', 'ready') for e in captured),
                                'profile': profile.root.name, 'version': version}).encode())
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    finally:
        if child is not None:
            child.stdin.close()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
            captured.append({'event': 'exit', 'code': child.returncode, 'pid': child.pid})
            profile.write('gateway-smoke.json' if gateway_entry else 'smoke.json', json.dumps(captured, indent=2).encode())
            log = Profile.__new__(Profile)
            log.root = profile.root / 'logs'
            log.fd = os.open('logs', DIRECTORY, dir_fd=profile.fd)
            try:
                log.write('process.json', json.dumps(captured, indent=2).encode())
            finally:
                os.close(log.fd)
        selector.close()
        server.close()
        for name in ['control.sock', 'state.json']:
            try:
                os.unlink(name, dir_fd=profile.fd)
            except FileNotFoundError:
                pass
        os.close(lock)
    if not any(c.get('event') == ('ready' if gateway_entry else 'initialize') for c in captured):
        raise ValueError('No successful initialize captured')
    return {'state': 'stopped', 'profile': profile.root.name, 'events': captured,
            'paths': {k: str(profile.root / v) for k, v in {
                'home': 'home', 'codexHome': 'codex-home', 'config': 'config/config.json',
                'dbRoot': 'config', 'pid': 'state.json', 'logs': 'logs/process.json', 'cwd': 'cwd'}.items()}}


def cleanup(profile):
    """Clean only stale lifecycle files; preserve credentials and evidence."""
    lock = os.open('owner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=profile.fd)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if control(profile, 'status')['state'] not in ('stale', 'stopped'):
            raise ValueError('Refusing cleanup of live profile')
        for name in ['state.json', 'control.sock']:
            try:
                os.unlink(name, dir_fd=profile.fd)
            except FileNotFoundError:
                pass
    finally:
        os.close(lock)
    return {'state': 'clean', 'preserved': 'credentials and evidence'}


def adapter(profile, operation, node):
    if not node or not Path(node).is_absolute():
        raise ValueError('Absolute Node executable required')
    # Manifest and credentials are read by descriptor, with all ancestor directories anchored.
    manifest_fd = profile.open_file('capture.json')
    descriptors = [manifest_fd]
    child = None
    try:
        manifest = json.loads(os.pread(manifest_fd, 1024 * 1024, 0))
        token_fd = profile.open_file(manifest['credentialFile'])
        descriptors.append(token_fd)
        evidence_fd = os.open(operation + '-evidence.jsonl', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                              0o600, dir_fd=profile.fd)
        descriptors.append(evidence_fd)
        profile.assert_identity()
        env = {k: os.environ[k] for k in ['PATH', 'LANG', 'TMPDIR'] if k in os.environ}
        env.update(HOME=str(profile.root / 'home'), ENV02_MANIFEST_FD=str(manifest_fd),
                   ENV02_TOKEN_FD=str(token_fd), ENV02_EVIDENCE_FD=str(evidence_fd))
        script = 'capture_proxy.mjs' if operation == 'capture' else 'capture_smoke.mjs'
        command = [sys.executable, str(Path(__file__).with_name('guarded_child.py').resolve()),
                   str(node), str(Path(__file__).with_name(script).resolve())]
        child = subprocess.Popen(command, env=env, pass_fds=tuple(descriptors), cwd=profile.root,
                                 stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            code = child.wait(timeout=310 if operation == 'capture' else 40)
        except BaseException:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
            raise
        if code != 0:
            raise ValueError('Adapter failed; sanitized evidence remains protected')
        return {'state': 'collected', 'operation': operation, 'exitCode': code}
    finally:
        if child is not None and child.stdin is not None:
            child.stdin.close()
        for fd in descriptors:
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['start', 'status', 'stop', 'cleanup', 'capture', 'smoke'])
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--codex', type=Path)
    parser.add_argument('--sha256')
    parser.add_argument('--seconds', type=int, default=15)
    parser.add_argument('--gateway-entry', type=Path)
    parser.add_argument('--node', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        with Profile(args.base, args.profile) as profile:
            if args.operation == 'start':
                if not args.codex or not args.sha256:
                    raise ValueError('Explicit executable and checksum required')
                result = run(profile, args.codex, args.sha256, args.seconds, args.gateway_entry, args.node)
            elif args.operation == 'cleanup':
                result = cleanup(profile)
            elif args.operation in ('capture', 'smoke'):
                result = adapter(profile, args.operation, args.node)
            else:
                result = control(profile, args.operation)
            print(json.dumps(result))
    except Exception:
        print('{"state":"refused"}')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
